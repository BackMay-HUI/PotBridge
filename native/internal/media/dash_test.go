package media

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

func dashAttrs(t *testing.T, b []byte, el, at string) []string {
	t.Helper()
	d := xml.NewDecoder(strings.NewReader(string(b)))
	var out []string
	for {
		tok, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if s, ok := tok.(xml.StartElement); ok && s.Name.Local == el {
			for _, a := range s.Attr {
				if a.Name.Local == at {
					out = append(out, a.Value)
				}
			}
		}
	}
	return out
}
func dashTexts(t *testing.T, b []byte, el string) []string {
	t.Helper()
	d := xml.NewDecoder(strings.NewReader(string(b)))
	var out []string
	for {
		tok, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if s, ok := tok.(xml.StartElement); ok && s.Name.Local == el {
			var v string
			if e := d.DecodeElement(&v, &s); e != nil {
				t.Fatal(e)
			}
			out = append(out, v)
		}
	}
	return out
}
func getDash(t *testing.T, raw string) ([]byte, int) {
	t.Helper()
	r, e := http.Get(raw)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Body.Close()
	b, e := io.ReadAll(r.Body)
	if e != nil {
		t.Fatal(e)
	}
	return b, r.StatusCode
}
func TestDASHInheritedTemplateAndSignedEscapedMedia(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.EscapedPath()+"?"+r.URL.RawQuery+"|"+r.Header.Get("Range"))
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, ".mpd") {
			w.Header().Set("Content-Type", "application/dash+xml")
			io.WriteString(w, `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S"><BaseURL>../assets/</BaseURL><Period><BaseURL>video/</BaseURL><AdaptationSet><SegmentTemplate initialization="init-$RepresentationID$.mp4?sig=a%2Bb&amp;x=2" media="$RepresentationID$/$Number%05d$-%2F.m4s?sig=z%2Fq" startNumber="7"><SegmentTimeline><S t="90" d="5" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="avc" bandwidth="100"><BaseURL>high/</BaseURL></Representation></AdaptationSet></Period></MPD>`)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 2-5/100")
		if r.Header.Get("Range") == "bytes=2-5" {
			w.WriteHeader(206)
		}
		w.Write([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 0})
	}))
	defer up.Close()
	c := Candidate{URL: up.URL + "/manifest/main.mpd?token=keep", Format: "dash"}
	p, e := fixtureClient().Probe(context.Background(), c)
	if e != nil {
		t.Fatalf("DASH preflight: %v", e)
	}
	if p.Format != "dash" || len(p.Checks) < 3 {
		t.Fatalf("missing media checks: %+v", p)
	}
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	s, e := relay.Create(c)
	if e != nil {
		t.Fatal(e)
	}
	req, _ := http.NewRequest("GET", s.URL, nil)
	req.Header.Set("Range", "bytes=0-10")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, b)
	}
	if !strings.Contains(s.URL, ".mpd") || resp.Header.Get("Content-Type") != "application/dash+xml" {
		t.Fatalf("%s %v", s.URL, resp.Header)
	}
	media := dashAttrs(t, b, "SegmentTemplate", "media")
	if len(media) != 1 {
		t.Fatal(string(b))
	}
	raw := strings.ReplaceAll(strings.ReplaceAll(media[0], "$RepresentationID$", "avc"), "$Number%05d$", "00007")
	if !strings.HasPrefix(raw, relay.baseURL+"/s/"+s.ID+"/") {
		t.Fatal(raw)
	}
	req, _ = http.NewRequest("GET", raw, nil)
	req.Header.Set("Range", "bytes=2-5")
	resp, e = http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 206 || resp.Header.Get("Content-Range") != "bytes 2-5/100" {
		t.Fatal(resp.StatusCode, resp.Header)
	}
	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, v := range seen {
		if v == "/assets/video/high/avc/00007-%2F.m4s?sig=z%2Fq|bytes=2-5" {
			found = true
		}
		if strings.Contains(v, ".mpd") && !strings.HasSuffix(v, "|") {
			t.Fatalf("MPD Range leaked: %s", v)
		}
	}
	if !found {
		t.Fatal(seen)
	}
}
func TestDASHSegmentBaseAndListPreflight(t *testing.T) {
	for _, structure := range []string{`<BaseURL>movie.mp4?sig=1</BaseURL><SegmentBase indexRange="100-199"><Initialization range="0-99"/></SegmentBase>`, `<SegmentList><Initialization sourceURL="init.mp4" range="0-99"/><SegmentURL media="part.m4s?sig=1" mediaRange="100-199" index="index.bin" indexRange="0-9"/></SegmentList>`} {
		t.Run(structure[:16], func(t *testing.T) {
			var mu sync.Mutex
			var ranges []string
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, ".mpd") {
					fmt.Fprintf(w, `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation id="v">%s</Representation></AdaptationSet></Period></MPD>`, structure)
					return
				}
				mu.Lock()
				ranges = append(ranges, r.Header.Get("Range"))
				mu.Unlock()
				w.Write([]byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 0})
			}))
			defer up.Close()
			p, e := fixtureClient().Probe(context.Background(), Candidate{URL: up.URL + "/main.mpd", Format: "dash"})
			if e != nil || len(p.Checks) < 3 {
				t.Fatalf("%+v %v", p, e)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(ranges) < 2 || ranges[0] != "bytes=0-99" || ranges[1] != "bytes=100-199" {
				t.Fatal(ranges)
			}
		})
	}
}
func TestDASHRejectsUnsafeAndMalformedManifests(t *testing.T) {
	cases := map[string]string{
		"drm": `<MPD><Period><AdaptationSet><ContentProtection/><Representation><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`, "entity": `<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]><MPD>&x;</MPD>`, "xlink": `<MPD xmlns:xlink="http://www.w3.org/1999/xlink"><Period xlink:href="https://evil.test/a.xml"/></MPD>`, "empty": `<MPD/>`, "wrong-root": `<html/>`, "deep": `<MPD>` + strings.Repeat(`<Period>`, 65) + strings.Repeat(`</Period>`, 65) + `</MPD>`, "too-large": `<MPD><!--` + strings.Repeat("x", 2*1024*1024) + `--></MPD>`, "too-many": `<MPD>` + strings.Repeat(`<S/>`, 50001) + `</MPD>`, "bad-template": `<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="$Unknown$.m4s"/></Representation></AdaptationSet></Period></MPD>`, "bad-host-template": `<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="https://$RepresentationID$.example/a.m4s"/></Representation></AdaptationSet></Period></MPD>`, "alternatives": `<MPD><BaseURL>https://a.test/</BaseURL><BaseURL>https://b.test/</BaseURL><Period/></MPD>`}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, b) }))
			defer up.Close()
			c := Candidate{URL: up.URL + "/a.mpd", Format: "dash"}
			_, e := fixtureClient().Probe(context.Background(), c)
			if e == nil || AsFault(e).Code == "UNSUPPORTED_DASH" || AsFault(e).Code == "INTERNAL_ERROR" {
				t.Fatalf("unvalidated rejection: %v", e)
			}
			relay := NewRelay(fixtureClient(), nil)
			defer relay.Close()
			s, _ := relay.Create(c)
			_, status := getDash(t, s.URL)
			if status != 502 {
				t.Fatal(status)
			}
		})
	}
}
func TestDASHDynamicRefreshCrossOriginAndInjection(t *testing.T) {
	var mu sync.Mutex
	leaked := false
	version := 0
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		leaked = leaked || r.Header.Get("Cookie") != ""
		mu.Unlock()
		io.WriteString(w, "media")
	}))
	defer cdn.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/clock" {
			io.WriteString(w, "2026-10-25T00:00:00Z")
			return
		}
		mu.Lock()
		version++
		v := version
		mu.Unlock()
		fmt.Fprintf(w, `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT2S"><Location>refresh.mpd</Location><UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="clock"/><Period><AdaptationSet><Representation id="v"><SegmentTemplate initialization="%s/init.mp4" media="%s/$Time$.m4s"><SegmentTimeline><S t="%d" d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`, cdn.URL, cdn.URL, v)
	}))
	defer up.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	s, _ := relay.Create(Candidate{URL: up.URL + "/main.mpd", Format: "dash", HeadersByOrigin: map[string]map[string]string{up.URL: {"Cookie": "private=1"}}})
	b, status := getDash(t, s.URL)
	if status != 200 {
		t.Fatalf("%d %s", status, b)
	}
	loc := dashTexts(t, b, "Location")
	clock := dashAttrs(t, b, "UTCTiming", "value")
	init := dashAttrs(t, b, "SegmentTemplate", "initialization")
	if len(loc) != 1 || len(clock) != 1 || len(init) != 1 {
		t.Fatal(string(b))
	}
	for _, raw := range []string{loc[0], clock[0], init[0]} {
		if !strings.HasPrefix(raw, relay.baseURL) {
			t.Fatal(raw)
		}
	}
	b2, status := getDash(t, loc[0])
	if status != 200 || string(b) == string(b2) || !strings.Contains(string(b2), `minimumUpdatePeriod="PT2S"`) {
		t.Fatalf("%d %s", status, b2)
	}
	getDash(t, clock[0])
	getDash(t, init[0])
	mu.Lock()
	wasLeaked := leaked
	mu.Unlock()
	if wasLeaked {
		t.Fatal("cookie leaked")
	}
	for _, suffix := range []string{"/../https://evil.test/x", "/%2e%2e/evil", "/https:%2f%2fevil.test/x", "/x%5cy"} {
		raw := strings.TrimSuffix(init[0], "/init.mp4") + suffix
		_, status := getDash(t, raw)
		if status < 400 {
			t.Fatal(raw)
		}
	}
	relay.Stop(s.ID)
	_, status = getDash(t, init[0])
	if status != 410 {
		t.Fatal(status)
	}
}

func TestDASHStructuralAndExpansionGuards(t *testing.T) {
	valid := `<MPD><Period><AdaptationSet><Representation><BaseURL>media.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`
	cases := map[string]string{
		"wrong hierarchy":     `<MPD><Representation><BaseURL>media.mp4</BaseURL></Representation></MPD>`,
		"hidden base":         strings.Replace(valid, "<Period>", `<Foo><BaseURL>https://evil.test/</BaseURL></Foo><Period>`, 1),
		"bad range":           strings.Replace(valid, "</Representation>", `<SegmentBase indexRange="0-9223372036854775807"/></Representation>`, 1),
		"invalid number":      strings.Replace(valid, "</Representation>", `<SegmentTemplate media="$Number$.m4s" startNumber="bad"/></Representation>`, 1),
		"zero timescale":      strings.Replace(valid, "</Representation>", `<SegmentTemplate media="$Number$.m4s" timescale="0"/></Representation>`, 1),
		"id injection":        `<MPD><Period><AdaptationSet><Representation id="../other"><SegmentTemplate media="$RepresentationID$-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`,
		"inherited expansion": `<MPD><Period><AdaptationSet><SegmentTemplate media="$Time$.m4s"><SegmentTimeline>` + strings.Repeat(`<S d="1"/>`, 1000) + `</SegmentTimeline></SegmentTemplate>` + strings.Repeat(`<Representation/>`, 120) + `</AdaptationSet></Period></MPD>`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := rewriteDASH([]byte(body), "https://cdn.example/main.mpd", func(r Resource) (string, error) { return r.URL, nil })
			if err == nil {
				t.Fatal("accepted malformed or excessive MPD")
			}
		})
	}
	var refs strings.Builder
	for i := 0; i < 33; i++ {
		fmt.Fprintf(&refs, `<Representation><BaseURL>https://cdn%d.example/file.mp4</BaseURL></Representation>`, i)
	}
	_, err := rewriteDASH([]byte(`<MPD><Period><AdaptationSet>`+refs.String()+`</AdaptationSet></Period></MPD>`), "https://cdn.example/main.mpd", func(r Resource) (string, error) { return r.URL, nil })
	if err == nil || AsFault(err).Code != "MANIFEST_ORIGIN_LIMIT" {
		t.Fatalf("origin overflow: %v", err)
	}
}
func TestDASHNamespaceAndDynamicManifestOnlyProbe(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/dash+xml")
		io.WriteString(w, `<?xml version="1.0"?><d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT2S"><d:Period><d:AdaptationSet><d:SegmentTemplate media="$Number$.m4s" duration="2"/><d:Representation id="v"/></d:AdaptationSet></d:Period></d:MPD>`)
	}))
	defer up.Close()
	c := Candidate{URL: up.URL + "/manifest", Format: "dash"}
	p, e := fixtureClient().Probe(context.Background(), c)
	if e != nil || !p.Live || len(p.Checks) != 1 {
		t.Fatalf("%+v %v", p, e)
	}
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	s, _ := relay.Create(c)
	b, status := getDash(t, s.URL)
	if status != 200 {
		t.Fatal(status, string(b))
	}
	d := xml.NewDecoder(strings.NewReader(string(b)))
	for {
		tok, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if start, ok := tok.(xml.StartElement); ok && start.Name.Space != "urn:mpeg:dash:schema:mpd:2011" {
			t.Fatalf("namespace corruption: %+v", start)
		}
	}
}
func TestDASHRefreshMappingBound(t *testing.T) {
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	info, _ := relay.Create(Candidate{URL: "https://cdn.example/a.mpd", Format: "dash"})
	s := relay.sessions[info.ID]
	for i := 0; i < 32; i++ {
		_, e := relay.dashResourceURL(s, Resource{URL: fmt.Sprintf("https://cdn%d.example/a.m4s", i), Kind: "dash-media"})
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e := relay.dashResourceURL(s, Resource{URL: "https://overflow.example/a.m4s", Kind: "dash-media"})
	if e == nil {
		t.Fatal("session origins unbounded")
	}
	for i := 0; i < 128; i++ {
		_, e = relay.dashResourceURL(s, Resource{URL: fmt.Sprintf("https://cdn0.example/%d.mpd", i), Kind: "dash-manifest"})
		if e != nil {
			t.Fatal(e)
		}
	}
	_, e = relay.dashResourceURL(s, Resource{URL: "https://cdn0.example/overflow.mpd", Kind: "dash-manifest"})
	if e == nil {
		t.Fatal("Location refresh mappings unbounded")
	}
}

func TestDASHBaseURLAvailabilityAndHTTPHeadClock(t *testing.T) {
	const clockDate = "Sun, 25 Oct 2026 00:00:00 GMT"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/clock" {
			w.Header().Set("Date", clockDate)
			return
		}
		io.WriteString(w, `<MPD type="dynamic"><BaseURL availabilityTimeOffset="1.5" availabilityTimeComplete="false">assets/</BaseURL><UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="clock"/><Period><AdaptationSet><Representation><SegmentTemplate media="$Number$.m4s" duration="2"/></Representation></AdaptationSet></Period></MPD>`)
	}))
	defer up.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	s, _ := relay.Create(Candidate{URL: up.URL + "/main.mpd", Format: "dash"})
	b, status := getDash(t, s.URL)
	if status != 200 {
		t.Fatal(status, string(b))
	}
	values := dashAttrs(t, b, "BaseURL", "availabilityTimeOffset")
	if len(values) != 1 || values[0] != "1.5" {
		t.Fatal("BaseURL availability semantics lost", string(b))
	}
	clock := dashAttrs(t, b, "UTCTiming", "value")
	if len(clock) != 1 {
		t.Fatal(string(b))
	}
	resp, e := http.Head(clock[0])
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.Header.Get("Date") != clockDate {
		t.Fatalf("upstream clock replaced: %s", resp.Header.Get("Date"))
	}
}
func TestDASHRejectsUnservablePathsBeforeSuccess(t *testing.T) {
	for _, path := range []string{"%2e%2e/secret.m4s", "foo%5cbar.m4s", "https:%2f%2fevil.test/a.m4s"} {
		body := []byte(`<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="` + path + `" duration="2"/></Representation></AdaptationSet></Period></MPD>`)
		_, e := rewriteDASH(body, "https://cdn.example/a.mpd", func(r Resource) (string, error) { return r.URL, nil })
		if e == nil {
			t.Fatal("MPD with unservable path returned success", path)
		}
	}
}

func TestDASHAdaptiveFixtureKeepsRepresentationInheritance(t *testing.T) {
	body, e := os.ReadFile("testdata/dash-adaptive.mpd")
	if e != nil {
		t.Fatal(e)
	}
	doc, e := rewriteDASH(body, "https://cdn.example/manifests/main.mpd", func(r Resource) (string, error) { return r.URL, nil })
	if e != nil {
		t.Fatal(e)
	}
	media := dashAttrs(t, doc.body, "SegmentTemplate", "media")
	want := []string{"https://cdn.example/media/360/$RepresentationID$-$Number%05d$.m4s?auth=s%2Fq", "https://cdn.example/media/1080/$RepresentationID$-$Number%05d$.m4s?auth=s%2Fq"}
	if len(media) != 2 || media[0] != want[0] || media[1] != want[1] {
		t.Fatalf("per-representation base inheritance: %v", media)
	}
	starts := dashAttrs(t, doc.body, "SegmentTemplate", "startNumber")
	if len(starts) != 2 || starts[0] != "10" || starts[1] != "20" {
		t.Fatal(starts)
	}
	timelines := dashAttrs(t, doc.body, "S", "t")
	if len(timelines) != 2 || timelines[0] != "5000" || timelines[1] != "5000" {
		t.Fatal(timelines)
	}
	if len(doc.samples) != 4 || doc.samples[1].URL != "https://cdn.example/media/360/low-00010.m4s?auth=s%2Fq" || doc.samples[2].URL != "https://cdn.example/media/audio/init.mp4" || doc.samples[3].Range != "200@0" {
		t.Fatalf("representative checks: %+v", doc.samples)
	}
}
func TestDASHMediaAndRedirectsAlwaysUseClientValidation(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("blocked destination reached") }))
	defer target.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/seg.m4s" {
			http.Redirect(w, r, target.URL+"/blocked", http.StatusFound)
			return
		}
		io.WriteString(w, `<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="seg.m4s" duration="2"/></Representation></AdaptationSet></Period></MPD>`)
	}))
	defer up.Close()
	client := fixtureClient()
	client.ValidateURL = func(ctx context.Context, u *url.URL) error {
		if u.Host == strings.TrimPrefix(target.URL, "http://") {
			return Failure("BLOCKED_ADDRESS", "network", "blocked")
		}
		return nil
	}
	relay := NewRelay(client, nil)
	defer relay.Close()
	s, _ := relay.Create(Candidate{URL: up.URL + "/main.mpd", Format: "dash"})
	b, _ := getDash(t, s.URL)
	urls := dashAttrs(t, b, "SegmentTemplate", "media")
	if len(urls) != 1 {
		t.Fatal(string(b))
	}
	_, status := getDash(t, urls[0])
	if status != 502 {
		t.Fatal(status)
	}
	summaries := relay.Summaries()
	if summaries[0].Error == nil || summaries[0].Error.Code != "BLOCKED_ADDRESS" {
		t.Fatal(summaries)
	}
}

func TestDASHRetainsLiteralPercentInEscapedPath(t *testing.T) {
	doc, e := rewriteDASH([]byte(`<MPD><Period><AdaptationSet><Representation><SegmentTemplate media="percent%25literal-$Number$.m4s" duration="2"/></Representation></AdaptationSet></Period></MPD>`), "https://cdn.example/main.mpd", func(r Resource) (string, error) { return r.URL, nil })
	if e != nil {
		t.Fatal(e)
	}
	media := dashAttrs(t, doc.body, "SegmentTemplate", "media")
	if len(media) != 1 || media[0] != "https://cdn.example/percent%25literal-$Number$.m4s" {
		t.Fatal(media)
	}
}
func TestDASHManifestReadFailureIsTyped(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "999")
		io.WriteString(w, "<MPD>")
	}))
	defer up.Close()
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	s, _ := relay.Create(Candidate{URL: up.URL + "/main.mpd", Format: "dash"})
	_, status := getDash(t, s.URL)
	if status != 502 {
		t.Fatal(status)
	}
	f := relay.Summaries()[0].Error
	if f == nil || f.Code != "READ_FAILED" {
		t.Fatalf("untyped read error: %+v", f)
	}
}

func TestDASHCannotTreatItsOwnManifestAsMedia(t *testing.T) {
	for name, addressing := range map[string]string{
		"unsegmented":       "",
		"segment base":      `<SegmentBase indexRange="0-99"/>`,
		"empty segment URL": `<SegmentList><SegmentURL/></SegmentList>`,
		"explicit segment":  `<SegmentList><SegmentURL media="manifest"/></SegmentList>`,
		"later segment":     `<SegmentList><SegmentURL media="seg.m4s"/><SegmentURL media="manifest"/></SegmentList>`,
		"segment index":     `<SegmentList><SegmentURL media="seg.m4s" index="manifest"/></SegmentList>`,
		"initialization":    `<SegmentList><Initialization/><SegmentURL media="seg.m4s"/></SegmentList>`,
		"template media":    `<SegmentTemplate media="manifest"/>`,
		"template init":     `<SegmentTemplate media="$Number$.m4s" initialization="manifest"/>`,
		"template index":    `<SegmentTemplate media="$Number$.m4s" index="manifest"/>`,
	} {
		t.Run(name, func(t *testing.T) {
			_, e := rewriteDASH([]byte(`<MPD><Period><AdaptationSet><Representation>`+addressing+`</Representation></AdaptationSet></Period></MPD>`), "https://cdn.example/manifest", func(r Resource) (string, error) { return r.URL, nil })
			if e == nil || AsFault(e).Code != "INVALID_MPD" {
				t.Fatalf("manifest URL must be rejected as media with INVALID_MPD: %v", e)
			}
		})
	}
}

func TestDASHEmptySegmentURLUsesMediaBaseURLAndRange(t *testing.T) {
	doc, e := rewriteDASH([]byte(`<MPD><BaseURL>media.mp4?sig=a%2Fb</BaseURL><Period><AdaptationSet><Representation><SegmentList><Initialization range="0-99"/><SegmentURL mediaRange="100-299"/></SegmentList></Representation></AdaptationSet></Period></MPD>`), "https://cdn.example/manifest", func(r Resource) (string, error) { return r.URL, nil })
	if e != nil {
		t.Fatal(e)
	}
	if len(doc.samples) != 2 || doc.samples[0].URL != "https://cdn.example/media.mp4?sig=a%2Fb" || doc.samples[0].Range != "100@0" || doc.samples[1].URL != "https://cdn.example/media.mp4?sig=a%2Fb" || doc.samples[1].Range != "200@100" {
		t.Fatalf("media file samples or ranges changed: %+v", doc.samples)
	}
	media := dashAttrs(t, doc.body, "SegmentURL", "media")
	if len(media) != 1 || media[0] != "https://cdn.example/media.mp4?sig=a%2Fb" {
		t.Fatal(media)
	}
}

func TestDASHTemplateMarkersPreserveLiteralURLs(t *testing.T) {
	for _, tc := range []struct {
		name, base, raw, want string
	}{
		{"path and query", "https://cdn.example/main.mpd", "__PB_DASH_0__-$Number$.m4s?sig=__PB_DASH_1__&rep=$RepresentationID$", "https://cdn.example/__PB_DASH_0__-$Number$.m4s?sig=__PB_DASH_1__&rep=$RepresentationID$"},
		{"inherited path", "https://cdn.example/__PB_DASH_0__/main.mpd?sig=__PB_DASH_1__", "$Number$.m4s", "https://cdn.example/__PB_DASH_0__/$Number$.m4s"},
		{"encoded inherited path", "https://cdn.example/%5F%5FPB_DASH_0__/main.mpd", "$Number$.m4s", "https://cdn.example/%5F%5FPB_DASH_0__/$Number$.m4s"},
		{"encoded path and query", "https://cdn.example/main.mpd", "%5F%5FPB_DASH_0__-$Number$.m4s?sig=%5F%5FPB_DASH_1__&rep=$RepresentationID$", "https://cdn.example/%5F%5FPB_DASH_0__-$Number$.m4s?sig=%5F%5FPB_DASH_1__&rep=$RepresentationID$"},
		{"inherited query and template", "https://cdn.example/__PB_DASH_0__-$Number%05d$.m4s?sig=__PB_DASH_1__&rep=$RepresentationID$", "", "https://cdn.example/__PB_DASH_0__-$Number%05d$.m4s?sig=__PB_DASH_1__&rep=$RepresentationID$"},
		{"inherited formatted template", "https://cdn.example/$Bandwidth%05d$/__PB_DASH_0__/", "$$-$RepresentationID$-$Number%09d$-$Time$.m4s?sig=__PB_DASH_1__", "https://cdn.example/$Bandwidth%05d$/__PB_DASH_0__/$$-$RepresentationID$-$Number%09d$-$Time$.m4s?sig=__PB_DASH_1__"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, e := resolveDASH(tc.base, tc.raw)
			if e != nil || got != tc.want {
				t.Fatalf("URL changed: got %q, error %v; want %q", got, e, tc.want)
			}
		})
	}
}

func TestDASHInheritedTemplateMarkersSurviveRelay(t *testing.T) {
	relay := NewRelay(fixtureClient(), nil)
	defer relay.Close()
	info, e := relay.Create(Candidate{URL: "https://cdn.example/manifest", Format: "dash"})
	if e != nil {
		t.Fatal(e)
	}
	doc, e := rewriteDASH([]byte(`<MPD><BaseURL>__PB_DASH_0__/</BaseURL><Period><AdaptationSet><SegmentTemplate media="__PB_DASH_1__-$Number%05d$.m4s?sig=__PB_DASH_0__&amp;rep=$RepresentationID$"/><Representation id="video"/></AdaptationSet></Period></MPD>`), "https://cdn.example/manifest", func(r Resource) (string, error) { return relay.dashResourceURL(relay.sessions[info.ID], r) })
	if e != nil {
		t.Fatal(e)
	}
	media := dashAttrs(t, doc.body, "SegmentTemplate", "media")
	if len(media) != 1 || !strings.HasSuffix(media[0], "/__PB_DASH_0__/__PB_DASH_1__-$Number%05d$.m4s?sig=__PB_DASH_0__&rep=$RepresentationID$") {
		t.Fatal(media)
	}
	if len(doc.samples) != 1 || doc.samples[0].URL != "https://cdn.example/__PB_DASH_0__/__PB_DASH_1__-00001.m4s?sig=__PB_DASH_0__&rep=video" {
		t.Fatalf("sample URL changed: %+v", doc.samples)
	}
}

func TestDASHSignedManifestBaseURLResolution(t *testing.T) {
	for _, tc := range []struct {
		name, base, raw, want string
	}{
		{"retained query", "https://cdn.example/manifest.mpd?sig=a$b", "", "https://cdn.example/manifest.mpd?sig=a$b"},
		{"relative directory", "https://cdn.example/manifest.mpd?sig=a$b", "media/", "https://cdn.example/media/"},
		{"absolute directory", "https://cdn.example/manifest.mpd?sig=a$b", "https://other.example/media/", "https://other.example/media/"},
		{"encoded retained query", "https://cdn.example/manifest.mpd?sig=a%24b", "", "https://cdn.example/manifest.mpd?sig=a%24b"},
		{"encoded discarded query", "https://cdn.example/manifest.mpd?sig=a%24b", "media/", "https://cdn.example/media/"},
		{"literal query with inherited template", "https://cdn.example/__PB_DASH_0__-$Number%05d$.m4s?sig=a$b", "", "https://cdn.example/__PB_DASH_0__-$Number%05d$.m4s?sig=a$b"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, e := resolveDASH(tc.base, tc.raw)
			if e != nil || got != tc.want {
				t.Fatalf("signed base URL changed: got %q, error %v; want %q", got, e, tc.want)
			}
		})
	}
}

func TestDASHSignedManifestWithRelativeBaseURL(t *testing.T) {
	doc, e := rewriteDASH([]byte(`<MPD><BaseURL>media/</BaseURL><Period><AdaptationSet><Representation><SegmentTemplate media="$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>`), "https://cdn.example/manifest.mpd?sig=a$b", func(r Resource) (string, error) { return r.URL, nil })
	if e != nil {
		t.Fatal(e)
	}
	media := dashAttrs(t, doc.body, "SegmentTemplate", "media")
	if len(media) != 1 || media[0] != "https://cdn.example/media/$Number$.m4s" || len(doc.samples) != 1 || doc.samples[0].URL != "https://cdn.example/media/1.m4s" {
		t.Fatalf("relative media resolution changed: %v, %+v", media, doc.samples)
	}
}

func TestDASHSignedRootWithoutBaseURLRewriteAndRelay(t *testing.T) {
	const manifest = `<MPD><Period><AdaptationSet><Representation id="v"><SegmentTemplate media="$Number$.m4s" initialization="init.mp4"/></Representation></AdaptationSet></Period></MPD>`
	doc, err := rewriteDASH([]byte(manifest), "https://cdn.example/manifest.mpd?sig=a$b", func(r Resource) (string, error) { return r.URL, nil })
	if err != nil {
		t.Fatalf("signed root rewrite: %v", err)
	}
	if got := dashAttrs(t, doc.body, "SegmentTemplate", "media"); len(got) != 1 || got[0] != "https://cdn.example/$Number$.m4s" {
		t.Fatalf("media: %v", got)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest.mpd" {
			if r.URL.RawQuery != "sig=a$b" {
				t.Errorf("signature changed: %s", r.URL)
			}
			w.Header().Set("Content-Type", "application/dash+xml")
			io.WriteString(w, manifest)
			return
		}
		if r.URL.RawQuery != "" {
			t.Errorf("inherited root query: %s", r.URL)
		}
		io.WriteString(w, "segment")
	}))
	defer upstream.Close()
	client := fixtureClient()
	candidate := Candidate{URL: upstream.URL + "/manifest.mpd?sig=a$b", Format: "dash"}
	if _, err := client.Probe(context.Background(), candidate); err != nil {
		t.Fatal(err)
	}
	relay := NewRelay(client, nil)
	defer relay.Close()
	session, err := relay.Create(candidate)
	if err != nil {
		t.Fatal(err)
	}
	body, status := getDash(t, session.URL)
	if status != 200 {
		t.Fatalf("relay: %d %s", status, body)
	}
	for _, attr := range []string{"media", "initialization"} {
		refs := dashAttrs(t, body, "SegmentTemplate", attr)
		if len(refs) != 1 {
			t.Fatalf("%s: %v", attr, refs)
		}
		data, status := getDash(t, strings.ReplaceAll(refs[0], "$Number$", "1"))
		if status != 200 || string(data) != "segment" {
			t.Fatalf("segment: %d %s", status, data)
		}
	}
}
