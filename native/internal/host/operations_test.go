package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"potbridge/native/internal/media"
	"potbridge/native/internal/protocol"
	"testing"
	"time"
)

type signaledOutput struct {
	responseBuffer
	changed chan struct{}
}

func (b *signaledOutput) Write(body []byte) (int, error) {
	n, err := b.responseBuffer.Write(body)
	select {
	case b.changed <- struct{}{}:
	default:
	}
	return n, err
}

func (b *signaledOutput) wait(t *testing.T, id string) map[string]any {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		b.Lock()
		reader := bytes.NewReader(append([]byte(nil), b.Buffer.Bytes()...))
		b.Unlock()
		for reader.Len() > 0 {
			body, err := protocol.Read(reader)
			if err != nil {
				// Writer emits the frame header and body separately. A snapshot
				// between those writes is incomplete, so await the next write.
				if err == io.EOF || err == io.ErrUnexpectedEOF {
					break
				}
				t.Fatal(err)
			}
			var reply map[string]any
			if err := json.Unmarshal(body, &reply); err != nil {
				t.Fatal(err)
			}
			if reply["requestId"] == id {
				return reply
			}
		}
		select {
		case <-b.changed:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", id)
		}
	}
}

func TestServeStopWithEightPendingPreflights(t *testing.T) {
	entered, canceled := make(chan struct{}, 8), make(chan struct{}, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/audio.mp4" {
			entered <- struct{}{}
			<-r.Context().Done()
			canceled <- struct{}{}
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0})
	}))
	defer upstream.Close()
	output := &signaledOutput{changed: make(chan struct{}, 32)}
	h := New(filepath.Join(t.TempDir(), "config.json"), output)
	defer h.Close()
	h.config.PlayerPath = os.Args[0]
	h.client.ValidateURL = func(context.Context, *url.URL) error { return nil }
	h.client.HTTP.Transport = http.DefaultTransport.(*http.Transport).Clone()
	candidate := media.Candidate{URL: upstream.URL + "/video.mp4", Format: "dash", Video: &media.Track{URL: upstream.URL + "/video.mp4"}, Audio: &media.Track{URL: upstream.URL + "/audio.mp4"}}
	input, sender := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer sender.Close()
	defer input.Close()
	done := make(chan error, 1)
	go func() { done <- h.Serve(ctx, input) }()
	writer := protocol.NewWriter(sender)
	for i := 0; i < 8; i++ {
		var request map[string]any
		_ = json.Unmarshal(requestBody(fmt.Sprint(i), "play", map[string]any{"candidate": candidate, "operationId": fmt.Sprint(i)}), &request)
		if err := writer.Send(request); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 8; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("eight preflights did not start")
		}
	}
	if err := writer.Send(map[string]any{"protocolVersion": 2, "requestId": "excess", "type": "probe", "candidate": candidate}); err != nil {
		t.Fatal(err)
	}
	if reply := output.wait(t, "excess"); reply["error"].(map[string]any)["code"] != "BUSY" {
		t.Fatalf("excess work was not bounded: %v", reply)
	}
	if err := writer.Send(map[string]any{"protocolVersion": 2, "requestId": "stop", "type": "stop"}); err != nil {
		t.Fatal(err)
	}
	if reply := output.wait(t, "stop"); reply["ok"] != true {
		t.Fatalf("stop was starved by preflights: %v", reply)
	}
	for i := 0; i < 8; i++ {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("stop did not cancel every preflight")
		}
		if reply := output.wait(t, fmt.Sprint(i)); reply["error"].(map[string]any)["code"] != "PLAY_CANCELLED" {
			t.Fatalf("pending play was not canceled: %v", reply)
		}
	}
	sender.Close()
	select {
	case err := <-done:
		if err != io.EOF {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("native serve did not finish")
	}
	if sessions := h.relay.Summaries(); len(sessions) != 0 {
		t.Fatalf("canceled work created sessions: %v", sessions)
	}
}

func TestStopOperationAfterSessionPublication(t *testing.T) {
	testPublishedSessionStop(t, false)
}

func TestCompletedReplacementSurvivesOldSessionCleanup(t *testing.T) {
	testPublishedSessionStop(t, true)
}

func testPublishedSessionStop(t *testing.T, replacement bool) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0})
	}))
	defer upstream.Close()
	var output responseBuffer
	h := New(filepath.Join(t.TempDir(), "config.json"), &output)
	defer h.Close()
	h.config.PlayerPath = os.Args[0]
	marker := filepath.Join(t.TempDir(), "launched.json")
	t.Setenv("POTBRIDGE_HOST_TEST_PLAYER", marker)
	h.client.ValidateURL = func(context.Context, *url.URL) error { return nil }
	h.client.HTTP.Transport = http.DefaultTransport.(*http.Transport).Clone()
	candidate := media.Candidate{URL: upstream.URL + "/video.mp4", Format: "dash", Video: &media.Track{URL: upstream.URL + "/video.mp4"}, Audio: &media.Track{URL: upstream.URL + "/audio.mp4"}}
	other, err := h.relay.Create(candidate)
	if err != nil {
		t.Fatal(err)
	}
	play := map[string]any{"candidate": candidate, "operationId": "published"}
	if replacement {
		play["sessionId"] = other.ID
	}
	h.Handle(context.Background(), requestBody("play", "play", play))
	reply := output.response(t, "play")
	if reply["ok"] != true {
		t.Fatal(reply)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("test player did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	session := reply["result"].(map[string]any)["session"].(map[string]any)
	stop := map[string]any{"operationId": "published"}
	expectedStatus, remainingID := http.StatusGone, other.ID
	if replacement {
		stop = map[string]any{"sessionId": other.ID}
		expectedStatus, remainingID = http.StatusOK, session["id"].(string)
	}
	h.Handle(context.Background(), requestBody("stop", "stop", stop))
	for _, key := range []string{"url", "audioUrl"} {
		response, err := http.Get(session[key].(string))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != expectedStatus {
			t.Fatalf("published %s returned %d, want %d", key, response.StatusCode, expectedStatus)
		}
	}
	if remaining := h.relay.Summaries(); len(remaining) != 1 || remaining[0].ID != remainingID {
		t.Fatal("stop affected a session that should remain active", remaining)
	}
}
