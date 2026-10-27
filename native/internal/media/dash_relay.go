package media

import (
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Origin identifiers are minted only from parsed MPD references. The client
// supplies an escaped path/query; scheme and authority always come from session state.
func (r *Relay) dashResourceURL(s *session, resource Resource) (string, error) {
	masked, restore, err := maskResolvedDASH(resource.URL)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(masked)
	if err != nil {
		return "", dashError("INVALID_URL", "DASH 地址无效。")
	}
	origin := u.Scheme + "://" + u.Host
	id := resourceID(Resource{URL: origin})
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dashOrigins == nil {
		s.dashOrigins = map[string]string{}
	}
	if _, ok := s.dashOrigins[id]; !ok && len(s.dashOrigins) >= 32 {
		return "", dashError("MANIFEST_ORIGIN_LIMIT", "DASH 会话上游来源超过 32 个。")
	}
	s.dashOrigins[id] = origin
	if resource.Kind == "dash-manifest" || resource.Kind == "dash-clock" {
		resourceKey := resourceID(resource)
		if _, exists := s.resources[resourceKey]; !exists {
			count := 0
			for _, entry := range s.resources {
				if entry.Kind == "dash-manifest" || entry.Kind == "dash-clock" {
					count++
				}
			}
			if count >= 128 {
				return "", dashError("MANIFEST_RESOURCE_LIMIT", "DASH 刷新地址超过 128 个，请重新发送。")
			}
		}
		s.resources[resourceKey] = resource
		return r.resourceURL(s, resource), nil
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	local := r.baseURL + "/s/" + s.info.ID + "/dash/" + id + path
	if u.RawQuery != "" || u.ForceQuery {
		local += "?" + u.RawQuery
	}
	return restore(local), nil
}
func safeDASHPath(raw string) bool {
	value := raw
	for i := 0; i < 4; i++ {
		if strings.ContainsAny(value, "\\:\x00\r\n") {
			return false
		}
		for _, part := range strings.Split(value, "/") {
			if part == "." || part == ".." {
				return false
			}
		}
		decoded, e := url.PathUnescape(value)
		if e != nil {
			// After the first decode, '%' can be a legitimate filename byte.
			// The original escaped path was already parsed by net/url.
			return i > 0
		}
		if decoded == value {
			return true
		}
		value = decoded
	}
	return !strings.Contains(value, "%")
}

// Called with the session mutex held.
func dashRequestResource(s *session, u *url.URL) (Resource, bool) {
	parts := strings.SplitN(u.EscapedPath(), "/", 6)
	if len(parts) != 6 || parts[1] != "s" || parts[3] != "dash" || len(u.String()) > 32768 {
		return Resource{}, false
	}
	origin, ok := s.dashOrigins[parts[4]]
	if !ok || !safeDASHPath(parts[5]) {
		return Resource{}, false
	}
	raw := origin + "/" + parts[5]
	if u.RawQuery != "" || u.ForceQuery {
		raw += "?" + u.RawQuery
	}
	return Resource{URL: raw, Kind: "dash-media"}, true
}
func (r *Relay) serveDASH(w http.ResponseWriter, req *http.Request, s *session, res *http.Response) {
	for _, h := range []string{"Content-Length", "Content-Range", "ETag", "Last-Modified", "Accept-Ranges"} {
		w.Header().Del(h)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, dashBodyLimit+1))
	if err != nil {
		err = Failure("READ_FAILED", "manifest", "DASH 清单读取失败。")
	}
	if err == nil {
		var doc dashDocument
		doc, err = rewriteDASH(body, res.Request.URL.String(), func(child Resource) (string, error) { return r.dashResourceURL(s, child) })
		if err == nil {
			w.Header().Set("Content-Type", "application/dash+xml")
			w.WriteHeader(200)
			if req.Method != "HEAD" {
				n, _ := w.Write(doc.body)
				s.mu.Lock()
				s.summary.Bytes += int64(n)
				s.mu.Unlock()
			}
			return
		}
	}
	f := AsFault(err)
	r.sessionFault(s, f)
	http.Error(w, f.Message, 502)
}
