package media

import (
	"strings"
	"testing"
)

func TestRewritePlaylistPreservesSignedRelativeResources(t *testing.T) {
	input := "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key?k=secret\"\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXTINF:6,\nseg.ts?s=a%2Bb\n#EXT-X-ENDLIST\n"
	var resources []Resource
	output, err := RewritePlaylist([]byte(input), "https://cdn.example/v/list.m3u8?auth=one", func(r Resource) string { resources = append(resources, r); return "http://127.0.0.1/token/" + r.Kind })
	if err != nil {
		t.Fatal(err)
	}
	if len(resources) != 3 {
		t.Fatalf("resources=%v", resources)
	}
	if resources[0].URL != "https://cdn.example/key?k=secret" || resources[2].URL != "https://cdn.example/v/seg.ts?s=a%2Bb" {
		t.Fatal(resources)
	}
	if !strings.Contains(string(output), "BYTERANGE=\"100@0\"") || strings.Contains(string(output), "secret") {
		t.Fatal(string(output))
	}
}

func TestRewriteMasterAudioAndIframeURIs(t *testing.T) {
	input := "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"main, stereo\",URI=\"audio.m3u8\"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI=\"iframe.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=500,AUDIO=\"a\"\nvideo.m3u8\n"
	var roles []string
	output, err := RewritePlaylist([]byte(input), "https://cdn.example/master.m3u8", func(r Resource) string { roles = append(roles, r.Kind); return "/local/" + r.Kind })
	if err != nil {
		t.Fatal(err)
	}
	if len(roles) != 3 || roles[0] != "audio" || roles[2] != "playlist" {
		t.Fatal(roles)
	}
	if !strings.Contains(string(output), "NAME=\"main, stereo\"") {
		t.Fatal(string(output))
	}
}

func TestUnsupportedPlaylistFeaturesAreExplicit(t *testing.T) {
	for _, input := range []string{
		"<html>Access denied</html>",
		"#EXTM3U\n#EXT-X-PART:DURATION=1,URI=\"part.m4s\"\n",
		"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key\"\n",
	} {
		if _, err := RewritePlaylist([]byte(input), "https://cdn.example/list.m3u8", func(r Resource) string { return r.URL }); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
}
