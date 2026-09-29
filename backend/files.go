package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// Pictures and sounds people upload for the app itself (avatars, emotes, soundboard), as opposed
// to chat attachments: only files of the expected kind are kept.

type fileKind struct {
	exts map[string]string // sniffed type → the extension it's stored and served under
	err  error             // the answer for anything else
}

var (
	imageKind = fileKind{imageExts, errors.New("use a PNG, JPEG, GIF, WebP or BMP picture")}
	soundKind = fileKind{map[string]string{
		"audio/mpeg":      ".mp3",
		"audio/wave":      ".wav",
		"application/ogg": ".ogg",
	}, errors.New("use an MP3, OGG or WAV sound")}
)

// sniff is http.DetectContentType, which only knows MP3 files that start with an ID3 tag, plus
// MP3 that starts straight with an audio frame.
func sniff(data []byte) string {
	t := http.DetectContentType(data)
	if t == "application/octet-stream" && len(data) > 1 && data[0] == 0xFF && data[1]&0xE0 == 0xE0 {
		return "audio/mpeg"
	}
	return t
}

// saveUpload stores a file of the given kind and returns its URL. Files are named by content (an
// unchanged file keeps its URL, and its browser cache) under the extension of the sniffed type, so
// nothing is ever served as something it isn't.
func saveUpload(kind fileKind, prefix string, data []byte) (string, error) {
	ext, ok := kind.exts[sniff(data)]
	if !ok {
		return "", kind.err
	}
	sum := sha256.Sum256(data)
	name := prefix + "-" + hex.EncodeToString(sum[:12]) + ext
	file := filepath.Join(uploadDir, name)
	if _, err := os.Stat(file); err != nil {
		if err := os.WriteFile(file, data, 0o644); err != nil {
			return "", err
		}
	}
	return "/files/" + name, nil
}

// uploadedFile saves the file in a form's "file" field, answering the request itself when there's
// no usable file.
func uploadedFile(w http.ResponseWriter, r *http.Request, kind fileKind, prefix string, limit int64, tooLarge string) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(avatarFormMemory); err != nil {
		http.Error(w, tooLarge, http.StatusRequestEntityTooLarge)
		return "", false
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "no file", http.StatusBadRequest)
		return "", false
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		serverError(w, err)
		return "", false
	}
	url, err := saveUpload(kind, prefix, data)
	if err == kind.err {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return "", false
	} else if err != nil {
		serverError(w, err)
		return "", false
	}
	return url, true
}
