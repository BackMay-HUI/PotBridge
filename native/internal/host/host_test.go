package host

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"potbridge/native/internal/media"
	"potbridge/native/internal/protocol"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if output := os.Getenv("POTBRIDGE_HOST_TEST_PLAYER"); output != "" && len(os.Args) > 1 && strings.HasPrefix(os.Args[1], "http://127.0.0.1:") {
		body, _ := json.Marshal(os.Args[1:])
		_ = os.WriteFile(output, body, 0600)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type responseBuffer struct {
	sync.Mutex
	bytes.Buffer
}

func (b *responseBuffer) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *responseBuffer) response(t *testing.T, id string) map[string]any {
	t.Helper()
	b.Lock()
	defer b.Unlock()
	r := bytes.NewReader(b.Buffer.Bytes())
	for r.Len() > 0 {
		body, err := protocol.Read(r)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		_ = json.Unmarshal(body, &value)
		if value["requestId"] == id {
			return value
		}
	}
	t.Fatalf("missing response %s", id)
	return nil
}
func requestBody(id, kind string, extra map[string]any) []byte {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["requestId"] = id
	extra["type"] = kind
	extra["protocolVersion"] = 2
	body, _ := json.Marshal(extra)
	return body
}
func TestStopCancelsPendingPairedPlay(t *testing.T) {
	for _, mode := range []string{"initial", "replacement", "session", "all"} {
		t.Run(mode, func(t *testing.T) {
			entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/audio.mp4" {
					close(entered)
					select {
					case <-r.Context().Done():
						close(canceled)
						return
					case <-release:
					}
				}
				w.Header().Set("Content-Type", "video/mp4")
				_, _ = w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0})
			}))
			defer upstream.Close()
			defer close(release)
			var output responseBuffer
			h := New(filepath.Join(t.TempDir(), "config.json"), &output)
			defer h.Close()
			h.client.ValidateURL = func(context.Context, *url.URL) error { return nil }
			h.client.HTTP.Transport = http.DefaultTransport.(*http.Transport).Clone()
			player := filepath.Join(t.TempDir(), "player.exe")
			binary, _ := os.ReadFile(os.Args[0])
			if err := os.WriteFile(player, binary, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(t.TempDir(), "launched.json")
			t.Setenv("POTBRIDGE_HOST_TEST_PLAYER", marker)
			h.config.PlayerPath = player
			candidate := media.Candidate{URL: upstream.URL + "/video.mp4", Format: "dash", Video: &media.Track{URL: upstream.URL + "/video.mp4"}, Audio: &media.Track{URL: upstream.URL + "/audio.mp4"}}
			old, err := h.relay.Create(candidate)
			if err != nil {
				t.Fatal(err)
			}
			extra := map[string]any{"candidate": candidate, "operationId": "pending"}
			if mode == "replacement" || mode == "session" {
				extra["sessionId"] = old.ID
			}
			done := make(chan struct{})
			go func() { defer close(done); h.Handle(context.Background(), requestBody("play", "play", extra)) }()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("preflight did not reach audio")
			}
			stop := map[string]any{}
			if mode == "initial" || mode == "replacement" {
				stop["operationId"] = "pending"
			}
			if mode == "replacement" || mode == "session" {
				stop["sessionId"] = old.ID
			}
			h.Handle(context.Background(), requestBody("stop", "stop", stop))
			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Error("stop did not cancel pending audio preflight")
				return
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("play did not finish after cancellation")
			}
			reply := output.response(t, "play")
			failure, _ := reply["error"].(map[string]any)
			if failure["code"] != "PLAY_CANCELLED" {
				t.Fatalf("play response: %v", reply)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("canceled play launched the player")
			}
			want := 0
			if mode == "initial" {
				want = 1
			}
			if got := len(h.relay.Summaries()); got != want {
				t.Fatalf("remaining sessions %d want %d", got, want)
			}
			if mode != "initial" {
				for _, raw := range []string{old.URL, old.AudioURL} {
					response, err := http.Get(raw)
					if err != nil {
						t.Fatal(err)
					}
					response.Body.Close()
					if response.StatusCode != 410 {
						t.Fatalf("stopped track status %d", response.StatusCode)
					}
				}
			}
		})
	}
}

func TestDiagnosticsExcludeRelayCredentialsAndPageTitles(t *testing.T) {
	h := New(filepath.Join(t.TempDir(), "config.json"), io.Discard)
	defer h.Close()
	session, err := h.relay.Create(media.Candidate{URL: "https://example.com/movie.mp4?secret=signed", Title: "private viewing title", Format: "mp4"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := h.dispatch(context.Background(), Request{Type: "diagnostics"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	for _, secret := range []string{session.ID, session.URL, "signed", "private viewing title"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("diagnostics leaked %q", secret)
		}
	}
}
