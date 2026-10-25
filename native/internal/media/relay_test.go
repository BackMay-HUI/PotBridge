package media

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureClient() *Client {
	c := NewClient(nil)
	c.ValidateURL = func(context.Context, *url.URL) error { return nil }
	c.HTTP.Transport = http.DefaultTransport.(*http.Transport).Clone()
	return c
}

func TestOversizeResourceListIsRejectedByProbeAndRelay(t *testing.T) {
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n")
	for i := 0; i < 9000; i++ {
		fmt.Fprintf(&playlist, "#EXTINF:1,\nseg-%d.ts\n", i)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".m3u8") {
			io.WriteString(w, playlist.String())
		} else {
			w.Write([]byte{0x47, 1, 2, 3})
		}
	}))
	defer upstream.Close()
	candidate := Candidate{URL: upstream.URL + "/list.m3u8", Format: "hls"}
	if _, err := fixtureClient().Probe(context.Background(), candidate); err == nil || AsFault(err).Code != "MANIFEST_RESOURCE_LIMIT" {
		t.Errorf("probe accepted resource overflow: %v", err)
	}
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(candidate)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(session.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 502 {
		t.Fatalf("overflow returned a broken success playlist: %d", response.StatusCode)
	}
	if summaries := relay.Summaries(); len(summaries) != 1 || summaries[0].Error == nil || summaries[0].Error.Code != "MANIFEST_RESOURCE_LIMIT" {
		t.Fatal(summaries)
	}
}

func TestPlaylistUpdateKeepsEveryResourceInTheReturnedWindow(t *testing.T) {
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, ".m3u8") {
			w.Write([]byte{0x47, 1, 2, 3})
			return
		}
		last := 8191
		if requests.Add(1) > 1 {
			last = 8192
		}
		io.WriteString(w, "#EXTM3U\n")
		for i := 0; i < 8191; i++ {
			fmt.Fprintf(w, "#EXTINF:1,\nseg-%d.ts\n", i)
		}
		fmt.Fprintf(w, "#EXTINF:1,\nseg-%d.ts\n", last)
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: upstream.URL + "/live.m3u8", Format: "hls"})
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		response, err := http.Get(session.URL)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != 200 {
			t.Fatal(response.StatusCode)
		}
		for _, line := range strings.Split(string(body), "\n") {
			if !strings.HasPrefix(line, "http://") {
				continue
			}
			resource, err := http.Get(line)
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(resource.Body)
			resource.Body.Close()
			if err != nil || resource.StatusCode != 200 || len(data) != 4 {
				t.Fatalf("window %d first segment unavailable: %d, %v", n, resource.StatusCode, err)
			}
			break
		}
	}
}

func TestCombinedTrackLimitNeverInvalidatesAnAcceptedTrack(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/master.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nvideo.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"main\",URI=\"audio.m3u8\"\n")
		case "/video.m3u8", "/audio.m3u8":
			io.WriteString(w, "#EXTM3U\n")
			for i := 0; i < 5000; i++ {
				fmt.Fprintf(w, "#EXTINF:1,\n%s-%d.ts\n", strings.TrimPrefix(r.URL.Path, "/"), i)
			}
		default:
			w.Write([]byte{0x47, 1, 2, 3})
		}
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: upstream.URL + "/master.m3u8", Format: "hls"})
	if err != nil {
		t.Fatal(err)
	}
	get := func(target string) (int, string) {
		t.Helper()
		response, err := http.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, string(body)
	}
	_, master := get(session.URL)
	links := regexp.MustCompile(`http://[^"\s]+`).FindAllString(master, -1)
	if len(links) != 2 {
		t.Fatal("missing tracks")
	}
	status, video := get(links[0])
	if status != 200 {
		t.Fatal(status)
	}
	segment := regexp.MustCompile(`http://[^"\s]+`).FindString(video)
	if status, _ := get(links[1]); status != 502 {
		t.Errorf("combined resource overflow accepted: %d", status)
	}
	if status, body := get(segment); status != 200 || len(body) != 4 {
		t.Fatalf("accepted video track was invalidated: %d", status)
	}
}

func TestStoppingSessionCancelsInFlightUpstream(t *testing.T) {
	started, cancelled := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: server.URL + "/movie.mp4", Format: "mp4"})
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan struct{})
	go func() {
		defer close(completed)
		response, _ := http.Get(session.URL)
		if response != nil {
			response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream was not requested")
	}
	relay.Stop(session.ID)
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request was not cancelled")
	}
	select {
	case <-completed:
	case <-time.After(3 * time.Second):
		t.Fatal("downstream did not finish")
	}
}

func TestProbeRejectsOversizePlaylistInsteadOfAcceptingPrefix(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/large.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			io.WriteString(w, "#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST\n"+strings.Repeat("#padding\n", 300000))
		} else {
			w.Header().Set("Content-Type", "video/mp2t")
			w.Write([]byte{0x47, 1, 2, 3})
		}
	}))
	defer server.Close()
	_, err := fixtureClient().Probe(context.Background(), Candidate{URL: server.URL + "/large.m3u8"})
	if err == nil || AsFault(err).Code != "MANIFEST_LIMIT" {
		t.Fatalf("expected manifest limit, got %v", err)
	}
}
func TestProbeChecksKeyMapAudioAndSegment(t *testing.T) {
	visited := map[string]bool{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		visited[r.URL.Path] = true
		switch r.URL.Path {
		case "/master.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"A\",URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nvideo.m3u8\n")
		case "/video.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:5,\nvideo.ts\n#EXT-X-ENDLIST\n")
		case "/audio.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXTINF:5,\naudio.aac\n#EXT-X-ENDLIST\n")
		case "/key":
			w.Write(make([]byte, 16))
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte{0x47, 1, 2, 3, 4})
		}
	}))
	defer upstream.Close()
	result, err := fixtureClient().Probe(context.Background(), Candidate{URL: upstream.URL + "/master.m3u8"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != "hls" {
		t.Fatal(result)
	}
	for _, path := range []string{"/key", "/init.mp4", "/video.ts", "/audio.m3u8", "/audio.aac"} {
		if !visited[path] {
			t.Errorf("not checked: %s", path)
		}
	}
}

func TestProbeRejectsSegmentHTMLAndReportsStage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list.m3u8" {
			io.WriteString(w, "#EXTM3U\n#EXTINF:5,\na.ts\n")
			return
		}
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<html>denied</html>")
	}))
	defer server.Close()
	_, err := fixtureClient().Probe(context.Background(), Candidate{URL: server.URL + "/list.m3u8"})
	if err == nil || AsFault(err).Stage != "segment" {
		t.Fatalf("error=%v", err)
	}
}

func TestProbeSelectsAudioGroupOfTheChosenVariant(t *testing.T) {
	visited := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		visited[r.URL.Path] = true
		switch r.URL.Path {
		case "/master.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"unused\",NAME=\"Unused\",URI=\"unused.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"selected\",NAME=\"Other\",URI=\"other.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"selected\",NAME=\"Default\",DEFAULT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"selected\"\nvideo.m3u8\n")
		case "/video.m3u8", "/audio.m3u8":
			io.WriteString(w, "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n")
		case "/segment.ts":
			w.Header().Set("Content-Type", "video/mp2t")
			w.Write([]byte{0x47, 1, 2, 3})
		default:
			w.WriteHeader(403)
		}
	}))
	defer server.Close()
	_, err := fixtureClient().Probe(context.Background(), Candidate{URL: server.URL + "/master.m3u8"})
	if err != nil {
		t.Fatal(err)
	}
	if !visited["/audio.m3u8"] || visited["/unused.m3u8"] || visited["/other.m3u8"] {
		t.Fatalf("wrong audio selection: %v", visited)
	}
}

func TestRedirectDoesNotForwardOtherOriginCookie(t *testing.T) {
	var cookie string
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { cookie = r.Header.Get("Cookie"); io.WriteString(w, "ok") }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	c := Candidate{URL: source.URL, HeadersByOrigin: map[string]map[string]string{source.URL: {"cookie": "private=secret"}}}
	res, err := fixtureClient().Fetch(context.Background(), c, c.URL, "GET", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if cookie != "" {
		t.Fatalf("leaked cookie: %s", cookie)
	}
}

func TestRelayRewritesLiveManifestOnEveryRequest(t *testing.T) {
	sequence := 1
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		if sequence == 1 {
			io.WriteString(w, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5,\none.ts?token=secret\n")
		} else {
			io.WriteString(w, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n#EXTINF:5,\ntwo.ts?token=secret\n")
		}
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: upstream.URL + "/live.m3u8", Format: "hls"})
	if err != nil {
		t.Fatal(err)
	}
	get := func() string {
		r, e := http.Get(session.URL)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return string(b)
	}
	first := get()
	sequence = 2
	second := get()
	if first == second || !strings.Contains(second, "MEDIA-SEQUENCE:2") || strings.Contains(second, "secret") || strings.Contains(second, upstream.URL) {
		t.Fatalf("first=%s second=%s", first, second)
	}
	if !strings.Contains(second, "127.0.0.1") {
		t.Fatal(second)
	}
	relay.Stop(session.ID)
	res, err := http.Get(session.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusGone {
		t.Fatal(res.StatusCode)
	}
}

func TestRelayForwardsRangeStatusAndRequiresToken(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=5-9" {
			t.Errorf("range=%s", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 5-9/100")
		w.WriteHeader(206)
		io.WriteString(w, "12345")
	}))
	defer upstream.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	session, err := relay.Create(Candidate{URL: upstream.URL + "/file.mp4", Format: "mp4"})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", session.URL, nil)
	req.Header.Set("Range", "bytes=5-9")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 206 || res.Header.Get("Content-Range") != "bytes 5-9/100" || string(data) != "12345" {
		t.Fatalf("bad range response: %d %s", res.StatusCode, data)
	}
	u, _ := url.Parse(session.URL)
	u.Path = "/s/invalid/root/media.mp4"
	denied, _ := http.Get(u.String())
	denied.Body.Close()
	if denied.StatusCode != 410 {
		t.Fatal(denied.StatusCode)
	}
	relay.Expire(time.Now().Add(31 * time.Minute))
	if len(relay.Summaries()) != 0 {
		t.Fatal("idle session not expired")
	}
}
