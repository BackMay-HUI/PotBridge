package media

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Candidate struct {
	ID              string                       `json:"id"`
	TabID           int                          `json:"tabId"`
	FrameID         int                          `json:"frameId"`
	PageKey         string                       `json:"pageKey"`
	PageURL         string                       `json:"pageUrl"`
	Title           string                       `json:"title"`
	Source          string                       `json:"source"`
	SectionID       string                       `json:"sectionId,omitempty"`
	URL             string                       `json:"url"`
	Format          string                       `json:"format"`
	CapturedAt      int64                        `json:"capturedAt"`
	HeadersByOrigin map[string]map[string]string `json:"headersByOrigin"`
	Video           *Track                       `json:"video,omitempty"`
	Audio           *Track                       `json:"audio,omitempty"`
	Quality         string                       `json:"quality,omitempty"`
	ContentID       string                       `json:"contentId,omitempty"`
	Live            bool                         `json:"live,omitempty"`
}

type Track struct {
	URL        string   `json:"url"`
	BackupURLs []string `json:"backupUrls,omitempty"`
	ID         string   `json:"id,omitempty"`
	MimeType   string   `json:"mimeType,omitempty"`
	Codecs     string   `json:"codecs,omitempty"`
	Bandwidth  float64  `json:"bandwidth,omitempty"`
	Width      float64  `json:"width,omitempty"`
	Height     float64  `json:"height,omitempty"`
	FrameRate  string   `json:"frameRate,omitempty"`
}

func validTrack(track *Track) bool {
	if track == nil {
		return false
	}
	if len(track.BackupURLs) > 2 || len(track.ID) > 100 || len(track.MimeType) > 100 || len(track.Codecs) > 100 || len(track.FrameRate) > 100 {
		return false
	}
	for _, raw := range append([]string{track.URL}, track.BackupURLs...) {
		u, err := url.Parse(raw)
		if err != nil || len(raw) > 16384 || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return false
		}
	}
	return true
}

type Resource struct {
	URL        string
	Kind       string
	Range      string
	Group      string
	AudioGroup string
	Default    bool
}
type Fault struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Stage   string `json:"stage,omitempty"`
	Status  int    `json:"status,omitempty"`
}

func (f *Fault) Error() string { return f.Message }
func Failure(code, stage, message string) *Fault {
	return &Fault{Code: code, Stage: stage, Message: message}
}
func AsFault(err error) *Fault {
	if f, ok := err.(*Fault); ok {
		return f
	}
	return Failure("INTERNAL_ERROR", "internal", "操作失败，请重新检测或查看诊断。")
}
func (c Candidate) Validate() error {
	if len(c.Quality) > 300 || len(c.ContentID) > 200 {
		return Failure("INVALID_INPUT", "input", "媒体标识过大。")
	}
	if c.Video != nil {
		if !validTrack(c.Video) || c.Video.URL != c.URL || c.Format != "dash" {
			return Failure("INVALID_INPUT", "video", "视频轨信息无效。")
		}
		if c.Audio == nil {
			return Failure("AUDIO_UNAVAILABLE", "audio", "只发现独立视频轨，尚未获得音轨。请在网页开始播放后重新检测。")
		}
		if !validTrack(c.Audio) {
			return Failure("INVALID_INPUT", "audio", "音轨信息无效。")
		}
	} else if c.Audio != nil {
		return Failure("INVALID_INPUT", "audio", "独立音轨缺少对应视频。")
	}
	if len(c.URL) > 16384 || len(c.Title) > 2048 || len(c.PageKey) > 1024 || len(c.HeadersByOrigin) > 32 {
		return Failure("INVALID_INPUT", "input", "媒体信息过大。")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return Failure("INVALID_URL", "input", "需要有效的 HTTP 或 HTTPS 媒体地址。")
	}
	for origin, headers := range c.HeadersByOrigin {
		u, err := url.Parse(origin)
		if err != nil || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return Failure("INVALID_INPUT", "input", "请求来源格式错误。")
		}
		if len(headers) > 16 {
			return Failure("INVALID_INPUT", "input", "请求头过多。")
		}
		for _, v := range headers {
			if len(v) > 16384 || strings.ContainsAny(v, "\r\n\x00") {
				return Failure("INVALID_INPUT", "input", "请求头包含无效字符。")
			}
		}
	}
	return nil
}
func (c Candidate) HeadersFor(rawURL string) http.Header {
	h := make(http.Header)
	u, err := url.Parse(rawURL)
	if err != nil {
		return h
	}
	for name, value := range c.HeadersByOrigin[u.Scheme+"://"+u.Host] {
		switch strings.ToLower(name) {
		case "referer", "origin", "user-agent", "cookie":
			if len(value) <= 16384 && !strings.ContainsAny(value, "\r\n\x00") {
				h.Set(name, value)
			}
		}
	}
	if h.Get("User-Agent") == "" {
		h.Set("User-Agent", "PotBridge/0.2")
	}
	h.Set("Accept-Encoding", "identity")
	return h
}
func DescribeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "invalid"
	}
	return u.Scheme + "://" + u.Host + "/…"
}
func HTTPFailure(status int, kind string) *Fault {
	code := "UPSTREAM_HTTP"
	message := fmt.Sprintf("媒体服务器返回 %d。", status)
	if status == 401 || status == 403 {
		code = "UPSTREAM_AUTH"
		message = fmt.Sprintf("%s请求返回 %d，请重新获取地址或检查网页登录状态。", kind, status)
	}
	if status == 407 {
		code = "PROXY_AUTH"
		message = "代理需要身份验证（407），请核对网络连接设置。"
	}
	return &Fault{Code: code, Message: message, Stage: kind, Status: status}
}
