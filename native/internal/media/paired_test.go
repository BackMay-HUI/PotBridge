package media

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func pairedCandidate(t *testing.T, video, audio string) Candidate {
	t.Helper()
	encoded, _ := json.Marshal(map[string]any{"url": video, "format": "dash", "video": map[string]any{"url": video, "mimeType": "video/mp4"}, "audio": map[string]any{"url": audio, "mimeType": "audio/mp4"}})
	var candidate Candidate
	if err := json.Unmarshal(encoded, &candidate); err != nil {
		t.Fatal(err)
	}
	return candidate
}

func audioURL(t *testing.T, info SessionInfo) string {
	t.Helper()
	encoded, _ := json.Marshal(info)
	var value map[string]string
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	return value["audioUrl"]
}

func TestPairedProbeChecksBothTracksAndReportsAudioFailure(t *testing.T) {
	var videoSeen, audioSeen atomic.Int64
	var failAudio atomic.Bool
	audio := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		audioSeen.Add(1)
		if r.Header.Get("Cookie") != "audio=1" {
			t.Error("wrong audio-origin cookie")
		}
		if failAudio.Load() {
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "audio/mp4")
		w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'})
	}))
	defer audio.Close()
	video := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		videoSeen.Add(1)
		if r.Header.Get("Cookie") != "video=1" {
			t.Error("wrong video-origin cookie")
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'})
	}))
	defer video.Close()
	candidate := pairedCandidate(t, video.URL+"/video.m4s", audio.URL+"/audio.m4s")
	candidate.HeadersByOrigin = map[string]map[string]string{video.URL: {"cookie": "video=1"}, audio.URL: {"cookie": "audio=1"}}
	result, err := fixtureClient().Probe(context.Background(), candidate)
	if err != nil || result.Format != "dash" || videoSeen.Load() != 1 || audioSeen.Load() != 1 {
		t.Fatalf("pair probe: %+v, %v, video=%d audio=%d", result, err, videoSeen.Load(), audioSeen.Load())
	}
	failAudio.Store(true)
	_, err = fixtureClient().Probe(context.Background(), candidate)
	if err == nil || AsFault(err).Code != "UPSTREAM_AUTH" || AsFault(err).Stage != "audio" {
		t.Fatalf("lost audio failure: %v", err)
	}
}

func TestPairedRelayRangesAndStopApplyToBothTracks(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=5-9" {
			t.Errorf("missing range for %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 5-9/100")
		w.WriteHeader(206)
		io.WriteString(w, "12345")
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(pairedCandidate(t, upstream.URL+"/v.m4s", upstream.URL+"/a.m4s"))
	if err != nil {
		t.Fatal(err)
	}
	audio := audioURL(t, session)
	if !strings.HasPrefix(audio, "http://127.0.0.1:") {
		t.Fatal("missing private local audio URL")
	}
	for _, target := range []string{session.URL, audio} {
		req, _ := http.NewRequest("GET", target, nil)
		req.Header.Set("Range", "bytes=5-9")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 206 || string(body) != "12345" {
			t.Fatalf("range response: %d %q", res.StatusCode, body)
		}
	}
	relay.Stop(session.ID)
	for _, target := range []string{session.URL, audio} {
		res, err := http.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 410 {
			t.Fatal("stopped track remained usable")
		}
	}
}

func TestFLVLiveProbeReturnsWithoutWaitingForTheStreamToEnd(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/x-flv")
		w.Write([]byte{'F', 'L', 'V', 1, 5, 0, 0, 0, 9, 0, 0, 0, 0})
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer upstream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	result, err := fixtureClient().Probe(ctx, Candidate{URL: upstream.URL + "/live.flv", Format: "flv"})
	if err != nil || result.Format != "flv" || !result.Live {
		t.Fatalf("live FLV probe: %+v %v", result, err)
	}
}

func TestStoppingPairCancelsBothInFlightTracks(t *testing.T) {
	started, cancelled := make(chan string, 2), make(chan string, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- r.URL.Path
		<-r.Context().Done()
		cancelled <- r.URL.Path
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(pairedCandidate(t, upstream.URL+"/v.m4s", upstream.URL+"/a.m4s"))
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan struct{}, 2)
	for _, target := range []string{session.URL, audioURL(t, session)} {
		go func(target string) {
			defer func() { completed <- struct{}{} }()
			res, _ := http.Get(target)
			if res != nil {
				res.Body.Close()
			}
		}(target)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("both tracks did not start")
		}
	}
	relay.Stop(session.ID)
	for i := 0; i < 2; i++ {
		select {
		case <-cancelled:
		case <-time.After(3 * time.Second):
			t.Fatal("track was not cancelled")
		}
		select {
		case <-completed:
		case <-time.After(3 * time.Second):
			t.Fatal("downstream did not finish")
		}
	}
}

func TestPairedProbeSelectsWorkingBackupWithoutChangingTrackIdentity(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/expired.m4s" {
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Write([]byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'})
	}))
	defer upstream.Close()
	candidate := pairedCandidate(t, upstream.URL+"/expired.m4s", upstream.URL+"/audio.m4s")
	candidate.Video.BackupURLs = []string{upstream.URL + "/working.m4s"}
	candidate.Video.ID = "80"
	candidate.ContentID = "cid:99"
	result, err := fixtureClient().Probe(context.Background(), candidate)
	if err != nil || result.Resolved == nil || result.Resolved.URL != upstream.URL+"/working.m4s" || result.Resolved.Video.ID != "80" || result.Resolved.ContentID != "cid:99" {
		t.Fatalf("backup resolution: %+v %v", result, err)
	}
}
