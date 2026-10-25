package host

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"potbridge/native/internal/media"
	"strings"
	"testing"
)

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
