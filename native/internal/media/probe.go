package media

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

type Check struct {
	Kind   string `json:"kind"`
	Origin string `json:"origin"`
	Status int    `json:"status"`
}
type ProbeResult struct {
	Format string  `json:"format"`
	Live   bool    `json:"live"`
	Checks []Check `json:"checks"`
}

func looksLikeError(headers http.Header, body []byte) bool {
	ct := strings.ToLower(headers.Get("Content-Type"))
	s := strings.ToLower(string(bytes.TrimSpace(body)))
	return strings.Contains(ct, "text/html") || strings.Contains(ct, "application/json") || strings.HasPrefix(s, "<html") || strings.HasPrefix(s, "<!doctype") || strings.HasPrefix(s, "<error")
}
func (c *Client) readBounded(ctx context.Context, candidate Candidate, resource Resource, limit int64) ([]byte, *http.Response, error) {
	h := http.Header{}
	if resource.Kind != "playlist" && resource.Kind != "audio" && resource.Kind != "root" && resource.Kind != "key" {
		value := ByteRangeHeader(resource.Range)
		if value == "" {
			value = "bytes=0-1023"
		}
		h.Set("Range", value)
	}
	if resource.Kind == "root" {
		h.Set("Range", "bytes=0-65535")
	}
	res, err := c.Fetch(ctx, candidate, resource.URL, "GET", h)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 206 {
		return nil, res, HTTPFailure(res.StatusCode, resource.Kind)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, res, Failure("READ_FAILED", resource.Kind, "读取媒体数据失败。")
	}
	if len(body) == 0 {
		return nil, res, Failure("EMPTY_MEDIA", resource.Kind, "媒体服务器返回空内容。")
	}
	if looksLikeError(res.Header, body) {
		return nil, res, Failure("NOT_MEDIA", resource.Kind, "服务器返回错误页面或 JSON，而非媒体数据。")
	}
	if int64(len(body)) > limit {
		if resource.Kind == "playlist" || resource.Kind == "audio" || (resource.Kind == "root" && DetectMedia(res.Request.URL.String(), res.Header, body) == "hls") {
			return nil, res, Failure("MANIFEST_LIMIT", "playlist", "播放清单超过 2 MiB 限制。")
		}
		body = body[:limit]
	}
	return body, res, nil
}
func (c *Client) Probe(parent context.Context, candidate Candidate) (ProbeResult, error) {
	result := ProbeResult{Checks: []Check{}}
	if err := candidate.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()
	body, res, err := c.readBounded(ctx, candidate, Resource{URL: candidate.URL, Kind: "root"}, 2*1024*1024)
	if err != nil {
		return result, err
	}
	result.Format = DetectMedia(res.Request.URL.String(), res.Header, body)
	result.Checks = append(result.Checks, Check{Kind: "root", Origin: DescribeURL(res.Request.URL.String()), Status: res.StatusCode})
	switch result.Format {
	case "mp4":
		return result, nil
	case "dash":
		return result, Failure("UNSUPPORTED_DASH", "manifest", "已识别 DASH；当前版本尚未实现该流的可靠中转，请保留案例以继续适配。")
	case "hls":
		if res.StatusCode == 206 {
			body, res, err = c.readBounded(ctx, candidate, Resource{URL: res.Request.URL.String(), Kind: "playlist"}, 2*1024*1024)
			if err != nil {
				return result, err
			}
		}
		err = c.probePlaylist(ctx, candidate, res.Request.URL.String(), body, &result, 0, map[string]bool{})
		return result, err
	default:
		return result, Failure("NOT_MEDIA", "root", "未检测到支持的 MP4 或 HLS 数据；可能是网页、错误响应或其他媒体格式。")
	}
}
func (c *Client) probePlaylist(ctx context.Context, candidate Candidate, rawURL string, body []byte, result *ProbeResult, depth int, seen map[string]bool) error {
	if depth > 4 || len(seen) > 12 {
		return Failure("MANIFEST_LIMIT", "playlist", "清单嵌套层数过多。")
	}
	if seen[rawURL] {
		return Failure("MANIFEST_CYCLE", "playlist", "播放清单出现循环引用。")
	}
	seen[rawURL] = true
	var resources []Resource
	_, err := RewritePlaylist(body, rawURL, func(r Resource) string { resources = append(resources, r); return r.URL })
	if err != nil {
		return err
	}
	chosen := map[string]bool{}
	audioGroup := ""
	for _, resource := range resources {
		if resource.Kind == "playlist" {
			audioGroup = resource.AudioGroup
			break
		}
	}
	audioURL := ""
	for _, resource := range resources {
		if resource.Kind == "audio" && resource.Group == audioGroup && audioGroup != "" {
			if audioURL == "" || resource.Default {
				audioURL = resource.URL
			}
			if resource.Default {
				break
			}
		}
	}
	hasVideo := false
	for _, r := range resources {
		if r.Kind == "audio" && r.URL != audioURL {
			continue
		}
		switch r.Kind {
		case "playlist", "audio", "init", "key", "segment":
		default:
			continue
		}
		if chosen[r.Kind] {
			continue
		}
		chosen[r.Kind] = true
		if r.Kind == "playlist" || r.Kind == "segment" {
			hasVideo = true
		}
		limit := int64(4096)
		if r.Kind == "playlist" || r.Kind == "audio" {
			limit = 2 * 1024 * 1024
		}
		child, res, e := c.readBounded(ctx, candidate, r, limit)
		if e != nil {
			return e
		}
		result.Checks = append(result.Checks, Check{Kind: r.Kind, Origin: DescribeURL(res.Request.URL.String()), Status: res.StatusCode})
		if r.Kind == "key" && len(child) != 16 {
			return Failure("INVALID_KEY", "key", "AES-128 密钥长度不是 16 字节。")
		}
		if r.Kind == "playlist" || r.Kind == "audio" {
			if e = c.probePlaylist(ctx, candidate, res.Request.URL.String(), child, result, depth+1, seen); e != nil {
				return e
			}
		}
	}
	if !hasVideo {
		return Failure("EMPTY_PLAYLIST", "playlist", "清单暂时没有可播放的媒体分片或子清单。")
	}
	if chosen["segment"] && !bytes.Contains(body, []byte("#EXT-X-ENDLIST")) {
		result.Live = true
	}
	return nil
}
