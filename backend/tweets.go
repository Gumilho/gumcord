package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net/url"
	"regexp"
	"strings"
)

// Previews of X (Twitter) posts, videos included, from the feed X's own embed widget reads: X
// shows its pages only to a few crawlers it knows. The video plays from X's servers once someone
// presses play.

var (
	tweetHosts = map[string]bool{
		"x.com": true, "twitter.com": true, "mobile.x.com": true, "mobile.twitter.com": true,
		// Links people "fix" for Discord previews.
		"fxtwitter.com": true, "vxtwitter.com": true, "fixupx.com": true, "fixvx.com": true,
	}
	tweetIDPattern = regexp.MustCompile(`^\d{1,20}$`)
)

const (
	maxTweetJSON    = 1 << 20
	maxTweetBitrate = 2_200_000 // 720p; the 1080p files are several times larger
)

// tweetID is the post a link points at, or "": /{user}/status/{id}, /i/status/{id}, /i/web/status/{id},
// with anything after (/photo/1, /video/1).
func tweetID(u *url.URL) string {
	if !tweetHosts[strings.TrimPrefix(u.Hostname(), "www.")] {
		return ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	for i := 1; i+1 < len(parts); i++ {
		if (parts[i] == "status" || parts[i] == "statuses") && tweetIDPattern.MatchString(parts[i+1]) {
			return parts[i+1]
		}
	}
	return ""
}

type tweetMedia struct {
	Type      string `json:"type"` // photo, video, animated_gif
	MediaURL  string `json:"media_url_https"`
	VideoInfo struct {
		Variants []struct {
			ContentType string `json:"content_type"`
			Bitrate     int    `json:"bitrate"`
			URL         string `json:"url"`
		} `json:"variants"`
	} `json:"video_info"`
}

func fetchTweet(ctx context.Context, target, id string) (*embed, error) {
	feed := "https://cdn.syndication.twimg.com/tweet-result?id=" + id + "&token=" + tweetToken(id) + "&lang=en"
	res, err := embedGet(ctx, feed, "application/json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var t struct {
		Typename         string `json:"__typename"` // "Tweet"; deleted and protected posts are "TweetTombstone"
		Text             string `json:"text"`
		DisplayTextRange []int  `json:"display_text_range"`
		User             struct {
			Name       string `json:"name"`
			ScreenName string `json:"screen_name"`
		} `json:"user"`
		MediaDetails []tweetMedia `json:"mediaDetails"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxTweetJSON)).Decode(&t); err != nil {
		return nil, err
	}
	if t.Typename != "Tweet" {
		return nil, errors.New("post unavailable")
	}

	// The text without the trailing link X adds for the media.
	text := []rune(t.Text)
	if r := t.DisplayTextRange; len(r) == 2 && 0 <= r[0] && r[0] <= r[1] && r[1] <= len(text) {
		text = text[r[0]:r[1]]
	}
	e := &embed{
		URL:         target,
		Kind:        "page",
		Site:        "X",
		Title:       clip(t.User.Name+" (@"+t.User.ScreenName+")", maxEmbedTitle),
		Description: clip(string(text), maxEmbedText),
	}
	for _, m := range t.MediaDetails {
		if m.Type == "video" || m.Type == "animated_gif" {
			if video := tweetVideo(m); video != "" {
				e.Video, e.Loop = video, m.Type == "animated_gif"
				e.Image = proxiedTwimg(m.MediaURL)
				break
			}
		}
	}
	if e.Video == "" {
		for _, m := range t.MediaDetails {
			if m.Type == "photo" {
				e.Image = proxiedTwimg(m.MediaURL)
				break
			}
		}
	}
	e.Large = e.Image != ""
	return e, nil
}

// tweetVideo picks the best MP4 up to 720p, from X's own video servers.
func tweetVideo(m tweetMedia) string {
	best, bestRate := "", -1
	for _, v := range m.VideoInfo.Variants {
		u, err := url.Parse(v.URL)
		if v.ContentType != "video/mp4" || err != nil || u.Scheme != "https" || u.Hostname() != "video.twimg.com" {
			continue
		}
		if v.Bitrate <= maxTweetBitrate && v.Bitrate > bestRate || best == "" {
			best, bestRate = v.URL, v.Bitrate
		}
	}
	return best
}

// X's pictures, through the image proxy like any preview's.
func proxiedTwimg(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != "pbs.twimg.com" {
		return ""
	}
	return proxiedImage(raw)
}

// tweetToken is the token X's embed widget sends with a post's ID:
// ((id / 1e15) * π).toString(36) with zeros and the point removed.
func tweetToken(id string) string {
	n, _ := new(big.Float).SetString(id)
	f, _ := n.Float64()
	return strings.NewReplacer("0", "", ".", "").Replace(jsBase36(f / 1e15 * math.Pi))
}

// jsBase36 writes a number as JavaScript's toString(36) does, following V8's DoubleToRadixCString:
// fraction digits only as far as the double's precision goes, rounded half to even.
func jsBase36(value float64) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	const radix = 36
	negative := value < 0
	value = math.Abs(value)
	integer := math.Floor(value)
	fraction := value - integer
	delta := math.Max(math.Nextafter(0, 1), 0.5*(math.Nextafter(value, math.Inf(1))-value))

	var frac []byte
	if fraction >= delta {
		for {
			fraction *= radix
			delta *= radix
			digit := int(fraction)
			frac = append(frac, digits[digit])
			fraction -= float64(digit)
			if (fraction > 0.5 || (fraction == 0.5 && digit&1 == 1)) && fraction+delta > 1 {
				// Round up, carrying through the digits already written.
				for {
					if len(frac) == 0 {
						integer++
						break
					}
					last := strings.IndexByte(digits, frac[len(frac)-1])
					frac = frac[:len(frac)-1]
					if last+1 < radix {
						frac = append(frac, digits[last+1])
						break
					}
				}
				break
			}
			if fraction < delta {
				break
			}
		}
	}

	var intDigits []byte
	for exp := math.Ilogb(integer / radix); integer/radix >= 1<<53 && exp > 52; exp = math.Ilogb(integer / radix) {
		integer /= radix
		intDigits = append(intDigits, '0')
	}
	for {
		remainder := math.Mod(integer, radix)
		intDigits = append(intDigits, digits[int(remainder)])
		integer = (integer - remainder) / radix
		if integer <= 0 {
			break
		}
	}
	for i, j := 0, len(intDigits)-1; i < j; i, j = i+1, j-1 {
		intDigits[i], intDigits[j] = intDigits[j], intDigits[i]
	}
	s := string(intDigits)
	if len(frac) > 0 {
		s += "." + string(frac)
	}
	if negative {
		s = "-" + s
	}
	return s
}
