package main

import (
	"context"
	"io"
	"os"
	"potbridge/native/internal/host"
	"potbridge/native/internal/platform"
	"potbridge/native/internal/protocol"
	"sync"
)

func main() {
	config := platform.ConfigPath()
	if len(os.Args) == 3 && os.Args[1] == "--config" {
		config = os.Args[2]
	}
	h := host.New(config, os.Stdout)
	defer h.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for {
		body, err := protocol.Read(os.Stdin)
		if err != nil {
			if err != io.EOF {
				os.Stderr.WriteString("PotBridge: invalid or interrupted native message\n")
			}
			break
		}
		limit <- struct{}{}
		wg.Add(1)
		go func(data []byte) { defer wg.Done(); defer func() { <-limit }(); h.Handle(ctx, data) }(body)
	}
	cancel()
	wg.Wait()
}
