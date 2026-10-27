package media

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestBilibiliRelaySuppliesRangeAfterSuccessfulPairedProbe(t *testing.T) {
	payload := []byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "browser-agent" || r.Header.Get("Referer") != "https://www.bilibili.com/" {
			t.Error("media headers changed")
		}
		rangeValue := r.Header.Get("Range")
		if rangeValue == "" {
			w.WriteHeader(567)
			return
		}
		body, contentRange := payload, "bytes 0-15/16"
		if rangeValue == "bytes=5-9" {
			body, contentRange = payload[5:10], "bytes 5-9/16"
			if r.Header.Get("If-Range") != "media-etag" {
				t.Error("If-Range changed")
			}
		} else if rangeValue != "bytes=0-" && rangeValue != "bytes=0-65535" {
			t.Errorf("unexpected range %q", rangeValue)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", contentRange)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		if r.Method != "HEAD" {
			_, _ = w.Write(body)
		}
	}))
	defer upstream.Close()
	candidate := pairedCandidate(t, upstream.URL+"/v.m4s", upstream.URL+"/a.m4s")
	candidate.Source = "bilibili"
	candidate.HeadersByOrigin = map[string]map[string]string{upstream.URL: {"user-agent": "browser-agent", "referer": "https://www.bilibili.com/"}}
	client := fixtureClient()
	if _, err := client.Probe(context.Background(), candidate); err != nil {
		t.Fatal("preflight should succeed with its explicit range", err)
	}
	relay := NewRelay(client, nil)
	defer relay.Close()
	session, err := relay.Create(candidate)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{session.URL, session.AudioURL} {
		for _, method := range []string{"GET", "HEAD"} {
			req, _ := http.NewRequest(method, target, nil)
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != 200 || response.Header.Get("Content-Range") != "" || response.ContentLength != int64(len(payload)) {
				t.Fatalf("range-less %s: status=%d headers=%v", method, response.StatusCode, response.Header)
			}
			if method == "GET" && string(body) != string(payload) {
				t.Fatal("full media body changed")
			}
		}
		req, _ := http.NewRequest("GET", target, nil)
		req.Header.Set("Range", "bytes=5-9")
		req.Header.Set("If-Range", "media-etag")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 206 || response.Header.Get("Content-Range") != "bytes 5-9/16" || string(body) != string(payload[5:10]) {
			t.Fatal("explicit seek range changed", response.StatusCode, response.Header)
		}
	}
}

func TestBilibiliRangeFallbackDoesNotMislabelPartialMedia(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=0-" {
			w.WriteHeader(567)
			return
		}
		w.Header().Set("Content-Range", "bytes 0-7/16")
		w.WriteHeader(206)
		_, _ = w.Write([]byte("partial!"))
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{Source: "bilibili", URL: upstream.URL + "/media.mp4", Format: "mp4"})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(session.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 206 || response.Header.Get("Content-Range") != "bytes 0-7/16" {
		t.Fatal("partial upstream range mislabeled as full body", response.StatusCode, response.Header)
	}
}

func TestBilibiliRangeFallbackLeavesGenericMediaAndLiveRequestsUnchanged(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			t.Error("range fallback applied outside Bilibili VOD")
		}
		_, _ = w.Write([]byte("media"))
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	for _, candidate := range []Candidate{{Source: "network", URL: upstream.URL + "/media.mp4", Format: "mp4"}, {Source: "bilibili", URL: upstream.URL + "/live.flv", Format: "flv", Live: true}} {
		session, err := relay.Create(candidate)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.Get(session.URL)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal(response.StatusCode)
		}
	}
}
