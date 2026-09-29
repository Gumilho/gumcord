package main

import (
	"context"
	"errors"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

const maxAvatarSize = 2 << 20

var avatarClient = &http.Client{Timeout: 5 * time.Second}

// importAvatar copies the identity provider's profile picture into the upload store, so clients
// load it from Gumcord instead of PocketID. Files are named by content: an unchanged picture keeps
// its URL, and its browser cache, across logins. Returns "" when there's nothing usable.
func importAvatar(ctx context.Context, pictureURL string) string {
	if pictureURL == "" || !sameHost(pictureURL, oidcIssuer) {
		return "" // only fetch from the identity provider itself
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pictureURL, nil)
	if err != nil {
		return ""
	}
	res, err := avatarClient.Do(req)
	if err != nil {
		log.Printf("avatar import: %v", err)
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("avatar import: %s returned %s", pictureURL, res.Status)
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxAvatarSize+1))
	if err != nil || len(data) > maxAvatarSize {
		return ""
	}
	url, err := saveImage("avatar", data)
	if err != nil {
		if err != errNotImage {
			log.Printf("avatar import: %v", err)
		}
		return ""
	}
	return url
}

var errNotImage = errors.New("use a PNG, JPEG, GIF, WebP or BMP picture")

// saveImage stores a picture in the upload store and returns its URL. Files are named by content
// (an unchanged picture keeps its URL, and its browser cache) under the extension of the sniffed
// type, so nothing but a picture is ever served as one.
func saveImage(prefix string, data []byte) (string, error) {
	ext, ok := imageExts[http.DetectContentType(data)]
	if !ok {
		return "", errNotImage
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

func sameHost(a, b string) bool {
	ua, err1 := url.Parse(a)
	ub, err2 := url.Parse(b)
	return err1 == nil && err2 == nil && ua.Scheme == ub.Scheme && ua.Host == ub.Host
}
