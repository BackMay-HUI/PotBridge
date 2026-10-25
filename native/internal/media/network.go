package media

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ProxyResolver func(*http.Request) (*url.URL, error)
type candidateContextKey struct{}
type Client struct {
	HTTP        *http.Client
	ValidateURL func(context.Context, *url.URL) error
}

var specialNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
}

func PublicIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range specialNetworks {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}
func PublicAddresses(ctx context.Context, host string) ([]netip.Addr, error) {
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, Failure("DNS_ERROR", "network", "无法解析媒体服务器域名。")
	}
	if len(ips) == 0 {
		return nil, Failure("DNS_ERROR", "network", "媒体服务器没有可用地址。")
	}
	for _, ip := range ips {
		if !PublicIP(ip) {
			return nil, Failure("BLOCKED_ADDRESS", "network", "媒体地址指向本机、内网或保留地址，已拒绝连接。")
		}
	}
	return ips, nil
}
func ValidatePublicURL(ctx context.Context, u *url.URL) error {
	if u == nil || u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return Failure("INVALID_URL", "network", "媒体地址格式无效。")
	}
	_, err := PublicAddresses(ctx, u.Hostname())
	return err
}
func NewClient(proxy ProxyResolver) *Client {
	var trustedProxy sync.Map
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.OnProxyConnectResponse = func(ctx context.Context, proxyURL *url.URL, connectReq *http.Request, connectRes *http.Response) error {
		if connectRes.StatusCode == http.StatusProxyAuthRequired {
			return HTTPFailure(connectRes.StatusCode, "proxy")
		}
		return nil
	}
	transport.Proxy = func(req *http.Request) (*url.URL, error) {
		if proxy == nil {
			return nil, nil
		}
		p, err := proxy(req)
		if err != nil {
			return nil, err
		}
		if p != nil {
			host := p.Host
			if p.Port() == "" {
				port := "80"
				if p.Scheme == "https" {
					port = "443"
				}
				host = net.JoinHostPort(p.Hostname(), port)
			}
			trustedProxy.Store(strings.ToLower(host), true)
		}
		return p, nil
	}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		d := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		if _, ok := trustedProxy.Load(strings.ToLower(addr)); ok {
			return d.DialContext(ctx, network, addr)
		}
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, Failure("INVALID_URL", "network", "媒体服务器地址无效。")
		}
		ips, err := PublicAddresses(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			conn, e := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
		}
		return nil, Failure("NETWORK_ERROR", "network", "无法连接媒体服务器，请检查代理和网络出口。")
	}
	transport.ResponseHeaderTimeout = 15 * time.Second
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.MaxIdleConnsPerHost = 8
	transport.DisableCompression = true
	client := &Client{ValidateURL: ValidatePublicURL}
	client.HTTP = &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return Failure("REDIRECT_LIMIT", "network", "媒体地址重定向次数过多。")
		}
		if err := client.ValidateURL(req.Context(), req.URL); err != nil {
			return err
		}
		c, _ := req.Context().Value(candidateContextKey{}).(Candidate)
		req.Header = c.HeadersFor(req.URL.String())
		for _, key := range []string{"Range", "If-Range"} {
			if len(via) > 0 && via[0].Header.Get(key) != "" {
				req.Header.Set(key, via[0].Header.Get(key))
			}
		}
		return nil
	}}
	return client
}
func (c *Client) Fetch(ctx context.Context, candidate Candidate, rawURL, method string, extra http.Header) (*http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, Failure("INVALID_URL", "network", "媒体地址无效。")
	}
	if err = c.ValidateURL(ctx, u); err != nil {
		return nil, err
	}
	ctx = context.WithValue(ctx, candidateContextKey{}, candidate)
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, Failure("INVALID_URL", "network", "无法构造媒体请求。")
	}
	req.Header = candidate.HeadersFor(rawURL)
	for _, key := range []string{"Range", "If-Range"} {
		if value := extra.Get(key); value != "" {
			req.Header.Set(key, value)
		}
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, Failure("REQUEST_CANCELLED", "network", "请求已取消或超时。")
		}
		var f *Fault
		if errors.As(err, &f) {
			return nil, f
		}
		return nil, Failure("NETWORK_ERROR", "network", "媒体请求失败，请核对代理、网络出口和证书。")
	}
	return res, nil
}
