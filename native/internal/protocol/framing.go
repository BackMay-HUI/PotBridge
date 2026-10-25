package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

const MaxInput = 256 * 1024

func Read(r io.Reader) ([]byte, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nil, err
	}
	if size == 0 || size > MaxInput {
		return nil, errors.New("invalid frame length")
	}
	body := make([]byte, size)
	_, err := io.ReadFull(r, body)
	return body, err
}

type Writer struct {
	mu  sync.Mutex
	out io.Writer
}

func NewWriter(out io.Writer) *Writer { return &Writer{out: out} }
func (w *Writer) Send(value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(body) > 1024*1024 {
		return errors.New("output frame too large")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err = binary.Write(w.out, binary.LittleEndian, uint32(len(body))); err != nil {
		return err
	}
	n, err := w.out.Write(body)
	if err == nil && n != len(body) {
		return io.ErrShortWrite
	}
	return err
}
