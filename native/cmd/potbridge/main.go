package main

import (
	"context"
	"io"
	"os"
	"potbridge/native/internal/host"
	"potbridge/native/internal/platform"
)

func main() {
	config := platform.ConfigPath()
	if len(os.Args) == 3 && os.Args[1] == "--config" {
		config = os.Args[2]
	}
	h := host.New(config, os.Stdout)
	defer h.Close()
	if err := h.Serve(context.Background(), os.Stdin); err != nil && err != io.EOF {
		os.Stderr.WriteString("PotBridge: invalid or interrupted native message\n")
	}
}
