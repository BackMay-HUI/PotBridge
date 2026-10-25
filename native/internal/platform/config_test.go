package platform

import (
	"path/filepath"
	"testing"
)

func TestConfigRoundTripAndRejectCredentialProxy(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	c := DefaultConfig()
	c.ProxyMode = "manual"
	c.ProxyURL = "http://127.0.0.1:7890"
	if err := SaveConfig(p, c); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(p)
	if err != nil || got.ProxyURL != c.ProxyURL {
		t.Fatalf("%v %v", got, err)
	}
	c.ProxyURL = "http://user:password@proxy.example"
	if err := c.Validate(); err == nil {
		t.Fatal("credential URL accepted")
	}
}
func TestProxySelectionAndBypass(t *testing.T) {
	u, err := ParseProxySpec("http=one.example:80;https=two.example:443", "https")
	if err != nil || u.Host != "two.example:443" {
		t.Fatalf("%v %v", u, err)
	}
	if !ProxyBypassed("host.local", "<local>;*.local") || !ProxyBypassed("printer", "<local>") || ProxyBypassed("public.example", "<local>;*.local") {
		t.Fatal("bypass mismatch")
	}
}
