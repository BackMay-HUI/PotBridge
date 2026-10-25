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
		h.Set("User-Agent", "PotBridge/0.1")
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
