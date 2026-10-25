package media

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Opt-in transport endurance test. This uses synthetic TS packet bytes, not a
// decoder, so it deliberately cannot certify actual video/audio playback.
func TestLiveRelayEndurance(t *testing.T) {
	rawDuration := os.Getenv("POTBRIDGE_LIVE_SOAK_SECONDS")
	if rawDuration == "" {
		t.Skip("set POTBRIDGE_LIVE_SOAK_SECONDS=900 for the 15-minute transport test")
	}
	seconds, err := strconv.Atoi(rawDuration)
	if err != nil || seconds < 15 || seconds > 3600 {
		t.Fatal("soak duration must be 15..3600 seconds")
	}
	duration := time.Duration(seconds) * time.Second
	started := time.Now()
	var ended atomic.Bool
	packets := bytes.Repeat(append([]byte{0x47}, make([]byte, 187)...), 32)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elapsed := time.Since(started)
		// Two distinct upstream outages, each followed by successful requests on the same session.
		for _, at := range []time.Duration{duration / 3, 2 * duration / 3} {
			if elapsed >= at && elapsed < at+2*time.Second {
				w.WriteHeader(503)
				return
			}
		}
		if r.URL.Path == "/live.m3u8" {
			sequence := int(elapsed / (2 * time.Second))
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:%d\n", sequence)
			for i := 0; i < 3; i++ {
				fmt.Fprintf(w, "#EXTINF:2.0,\nseg-%d.ts?signature=fixture-secret\n", sequence+i)
			}
			if ended.Load() {
				fmt.Fprintln(w, "#EXT-X-ENDLIST")
			}
			return
		}
		w.Header().Set("Content-Type", "video/mp2t")
		w.Write(packets)
	}))
	defer upstream.Close()
	var errorsSeen atomic.Int64
	relay := NewRelay(fixtureClient(), func(event map[string]any) {
		if event["type"] == "sessionError" {
			errorsSeen.Add(1)
		}
	})
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: upstream.URL + "/live.m3u8", Format: "hls"})
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	runtime.GC()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	windows, failures, recoveries, segmentRequests := 0, 0, 0, 0
	previousSequence, failed := "", false
	nextProgress := time.Minute
	poll := func() string {
		response, getErr := client.Get(session.URL)
		if getErr != nil {
			t.Fatal(getErr)
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if response.StatusCode != 200 {
			failures++
			failed = true
			return ""
		}
		if failed {
			recoveries++
			failed = false
		}
		playlist := string(body)
		if strings.Contains(playlist, "fixture-secret") || strings.Contains(playlist, upstream.URL) {
			t.Fatal("upstream URL leaked through rewritten playlist")
		}
		for _, line := range strings.Split(playlist, "\n") {
			if strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:") && line != previousSequence {
				windows++
				previousSequence = line
			}
			if strings.HasPrefix(line, "http://") {
				resource, resourceErr := client.Get(line)
				if resourceErr != nil {
					t.Fatal(resourceErr)
				}
				data, readErr := io.ReadAll(resource.Body)
				resource.Body.Close()
				if readErr != nil {
					t.Fatal(readErr)
				}
				if resource.StatusCode != 200 {
					failures++
					failed = true
					continue
				}
				if !bytes.Equal(data, packets) {
					t.Fatal("segment bytes changed in relay")
				}
				segmentRequests++
			}
		}
		return playlist
	}
	for time.Since(started) < duration {
		poll()
		elapsed := time.Since(started)
		if elapsed >= nextProgress {
			t.Logf("elapsed=%s windows=%d segments=%d failures=%d recoveries=%d", elapsed.Round(time.Second), windows, segmentRequests, failures, recoveries)
			nextProgress += time.Minute
		}
		time.Sleep(time.Second)
	}
	ended.Store(true)
	if !strings.Contains(poll(), "#EXT-X-ENDLIST") {
		t.Fatal("live end marker did not reach downstream")
	}
	if failures < 2 || recoveries < 2 || errorsSeen.Load() < 2 {
		t.Fatalf("outage recovery missing: failures=%d recoveries=%d events=%d", failures, recoveries, errorsSeen.Load())
	}
	if windows < seconds/3 {
		t.Fatalf("live window froze: windows=%d", windows)
	}
	relay.mu.Lock()
	active := relay.sessions[session.ID]
	relay.mu.Unlock()
	active.mu.Lock()
	resources, running := len(active.resources), active.active
	active.mu.Unlock()
	if resources > 8193 || running != 0 {
		t.Fatalf("resource lifecycle: mapped=%d active=%d", resources, running)
	}
	runtime.GC()
	var final runtime.MemStats
	runtime.ReadMemStats(&final)
	if final.HeapAlloc > baseline.HeapAlloc+32*1024*1024 {
		t.Fatalf("unexpected retained heap growth: baseline=%d final=%d", baseline.HeapAlloc, final.HeapAlloc)
	}
	relay.Stop(session.ID)
	if len(relay.Summaries()) != 0 {
		t.Fatal("session retained after stop")
	}
	response, err := client.Get(session.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 410 {
		t.Fatal("stopped URL remained usable")
	}
	t.Logf("duration=%s windows=%d segments=%d failures=%d recoveries=%d mapped=%d heapBefore=%d heapAfter=%d stopped=410", time.Since(started).Round(time.Second), windows, segmentRequests, failures, recoveries, resources, baseline.HeapAlloc, final.HeapAlloc)
}
