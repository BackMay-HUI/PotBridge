package media

import (
	"bytes"
	"encoding/binary"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var uriAttr = regexp.MustCompile(`(^|,)URI="([^"]*)"`)
var rangeAttr = regexp.MustCompile(`(?:^|,)BYTERANGE="([^"]+)"`)
var methodAttr = regexp.MustCompile(`(?:^|,)METHOD=([^,]+)`)
var keyFormatAttr = regexp.MustCompile(`(?:^|,)KEYFORMAT="([^"]+)"`)
var attribute = regexp.MustCompile(`(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)`)

const maxPlaylistResources = 8192

func attributeValue(payload, name string) string {
	for _, pair := range attribute.FindAllStringSubmatch(payload, -1) {
		if pair[1] == name {
			return strings.Trim(pair[2], `"`)
		}
	}
	return ""
}

func RewritePlaylist(body []byte, baseURL string, mapResource func(Resource) string) ([]byte, error) {
	if len(body) > 2*1024*1024 {
		return nil, Failure("MANIFEST_TOO_LARGE", "playlist", "播放清单超过大小限制。")
	}
	text := strings.TrimPrefix(string(body), "\ufeff")
	if !strings.HasPrefix(strings.TrimSpace(text), "#EXTM3U") {
		return nil, Failure("NOT_MEDIA", "playlist", "返回内容不是 HLS 播放清单。")
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil, Failure("INVALID_URL", "playlist", "清单地址无效。")
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	nextKind := "segment"
	nextRange := ""
	nextAudioGroup := ""
	var mapErr error
	resources := make(map[string]bool)
	resolve := func(value string, resource Resource) string {
		if mapErr != nil {
			return ""
		}
		if strings.Contains(value, "{$") {
			mapErr = Failure("UNSUPPORTED_HLS", "playlist", "暂不支持带变量替换的 HLS 清单。")
			return ""
		}
		relative, e := url.Parse(value)
		if e != nil {
			mapErr = Failure("INVALID_URL", "playlist", "清单内有无效地址。")
			return ""
		}
		target := base.ResolveReference(relative)
		target.Fragment = ""
		if target.User != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
			mapErr = Failure("INVALID_URL", "playlist", "清单包含不支持的资源地址。")
			return ""
		}
		resource.URL = target.String()
		resources[resource.URL] = true
		if len(resources) > maxPlaylistResources {
			mapErr = Failure("MANIFEST_RESOURCE_LIMIT", "playlist", "单份播放清单的资源数超过 8192 上限。")
			return ""
		}
		return mapResource(resource)
	}
	for i, line := range lines {
		line = strings.TrimSpace(line)
		lines[i] = line
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			lines[i] = resolve(line, Resource{Kind: nextKind, Range: nextRange, AudioGroup: nextAudioGroup})
			nextKind = "segment"
			nextRange = ""
			nextAudioGroup = ""
			continue
		}
		tag, payload, _ := strings.Cut(line, ":")
		switch tag {
		case "#EXT-X-PART", "#EXT-X-PART-INF", "#EXT-X-PRELOAD-HINT", "#EXT-X-SERVER-CONTROL", "#EXT-X-RENDITION-REPORT", "#EXT-X-SKIP", "#EXT-X-DEFINE":
			return nil, Failure("UNSUPPORTED_HLS", "playlist", "此清单使用第一版尚未支持的低延迟或变量功能。")
		case "#EXT-X-STREAM-INF":
			nextKind = "playlist"
			nextAudioGroup = attributeValue(payload, "AUDIO")
		case "#EXT-X-BYTERANGE":
			nextRange = payload
		}
		kind := "metadata"
		rng := ""
		switch tag {
		case "#EXT-X-KEY", "#EXT-X-SESSION-KEY":
			method := methodAttr.FindStringSubmatch(payload)
			format := keyFormatAttr.FindStringSubmatch(payload)
			if len(method) < 2 || (method[1] != "NONE" && method[1] != "AES-128") || (len(format) > 1 && format[1] != "identity") {
				return nil, Failure("UNSUPPORTED_ENCRYPTION", "key", "此流的加密方式不在第一版支持范围。")
			}
			if method[1] == "NONE" {
				continue
			}
			kind = "key"
			if !uriAttr.MatchString(payload) {
				return nil, Failure("INVALID_HLS", "key", "加密清单缺少密钥地址。")
			}
		case "#EXT-X-MAP":
			kind = "init"
			if match := rangeAttr.FindStringSubmatch(payload); len(match) > 1 {
				rng = match[1]
			}
		case "#EXT-X-MEDIA":
			kind = "playlist"
			if strings.Contains(payload, "TYPE=AUDIO") {
				kind = "audio"
			}
			if strings.Contains(payload, "TYPE=SUBTITLES") {
				kind = "subtitle"
			}
		case "#EXT-X-I-FRAME-STREAM-INF":
			kind = "iframe"
		}
		if uriAttr.MatchString(payload) {
			payload = uriAttr.ReplaceAllStringFunc(payload, func(attr string) string {
				match := uriAttr.FindStringSubmatch(attr)
				return match[1] + `URI="` + resolve(match[2], Resource{Kind: kind, Range: rng, Group: attributeValue(payload, "GROUP-ID"), Default: attributeValue(payload, "DEFAULT") == "YES"}) + `"`
			})
			lines[i] = tag + ":" + payload
		}
	}
	if mapErr != nil {
		return nil, mapErr
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func ByteRangeHeader(value string) string {
	parts := strings.SplitN(value, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	n, e1 := strconv.ParseInt(parts[0], 10, 64)
	offset, e2 := strconv.ParseInt(parts[1], 10, 64)
	if e1 != nil || e2 != nil || n <= 0 || offset < 0 || offset > 1<<53 || n > 1<<40 {
		return ""
	}
	return "bytes=" + strconv.FormatInt(offset, 10) + "-" + strconv.FormatInt(offset+n-1, 10)
}

func DetectMedia(rawURL string, headers map[string][]string, body []byte) string {
	contentType := ""
	for k, v := range headers {
		if strings.EqualFold(k, "Content-Type") && len(v) > 0 {
			contentType = strings.ToLower(v[0])
		}
	}
	trimmed := bytes.TrimSpace(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}))
	if strings.Contains(contentType, "text/html") || strings.Contains(contentType, "application/json") || bytes.HasPrefix(trimmed, []byte("<html")) || bytes.HasPrefix(trimmed, []byte("<!DOCTYPE")) || bytes.HasPrefix(trimmed, []byte("{")) {
		return ""
	}
	if bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
		return "hls"
	}
	if bytes.Contains(trimmed, []byte("<MPD")) {
		return "dash"
	}
	if len(body) >= 8 && (string(body[4:8]) == "ftyp" || string(body[4:8]) == "styp") {
		return "mp4"
	}
	if len(body) >= 9 && string(body[:3]) == "FLV" && body[3] == 1 && body[4]&^byte(5) == 0 && binary.BigEndian.Uint32(body[5:9]) >= 9 && binary.BigEndian.Uint32(body[5:9]) <= 1024*1024 {
		return "flv"
	}
	return ""
}
