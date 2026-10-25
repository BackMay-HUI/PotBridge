package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

func TestHTTPSProxyAuthenticationHasSpecificFault(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" {
			t.Errorf("expected CONNECT, got %s", r.Method)
		}
		w.WriteHeader(http.StatusProxyAuthRequired)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	client := NewClient(func(*http.Request) (*url.URL, error) { return proxyURL, nil })
	// The destination never connects: this fixture isolates the proxy CONNECT response.
	client.ValidateURL = func(context.Context, *url.URL) error { return nil }
	_, err := client.Fetch(context.Background(), Candidate{}, "https://public.example/media.mp4", "GET", nil)
	if err == nil || AsFault(err).Code != "PROXY_AUTH" {
		t.Fatalf("expected PROXY_AUTH, got %v", err)
	}
}

func TestRejectNonPublicAddresses(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "198.18.0.1"} {
		if PublicIP(netip.MustParseAddr(ip)) {
			t.Fatalf("accepted %s", ip)
		}
	}
	if !PublicIP(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("rejected public address")
	}
}

func TestHeaderContextsAreOriginScoped(t *testing.T) {
	c := Candidate{HeadersByOrigin: map[string]map[string]string{"https://a.example": {"cookie": "a=1", "authorization": "Bearer account", "referer": "https://page.example/"}}}
	h := c.HeadersFor("https://b.example/segment.ts")
	if h.Get("Cookie") != "" || h.Get("Authorization") != "" {
		t.Fatal(h)
	}
	h = c.HeadersFor("https://a.example/file.m3u8")
	if h.Get("Cookie") != "a=1" || h.Get("Authorization") != "" {
		t.Fatal(h)
	}
	if h.Get("Referer") != "https://page.example/" {
		t.Fatal(h)
	}
}

func TestMediaDetectionRejectsErrorResponses(t *testing.T) {
	if DetectMedia("https://a.example/x.m3u8", http.Header{"Content-Type": {"text/html"}}, []byte("<html>login</html>")) != "" {
		t.Fatal("HTML accepted")
	}
	if DetectMedia("https://a.example/stream", http.Header{}, []byte("#EXTM3U\n")) != "hls" {
		t.Fatal("playlist not detected")
	}
	if DetectMedia("https://a.example/stream", http.Header{}, []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}) != "mp4" {
		t.Fatal("MP4 not detected")
	}
}
