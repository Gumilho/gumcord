package main

import (
	"net/http"
	"sync"
	"time"
)

// Token buckets per key (usually a user): a burst straight away, then a steady rate. Enough to
// keep one account, or a script with its cookie, from flooding chat, filling the disk or turning
// the server into a crawler.

type limiter struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64
	buckets map[any]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perSecond float64, burst int) *limiter {
	return &limiter{rate: perSecond, burst: float64(burst), buckets: map[any]*bucket{}}
}

// allow spends a token for key, or says no.
func (l *limiter) allow(key any) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b := l.buckets[key]
	if b == nil {
		// Forget keys whose buckets have refilled; nothing is lost by starting them over.
		if len(l.buckets) >= 10_000 {
			for k, old := range l.buckets {
				if now.Sub(old.last).Seconds()*l.rate >= l.burst {
					delete(l.buckets, k)
				}
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

var (
	// Changes of any kind (edits, deletes, settings) per user.
	changeLimit = newLimiter(5, 40)
	// Uploads (attachments, pictures, emotes, stickers, sounds) per user: twenty, then one every three seconds.
	uploadLimit = newLimiter(1.0/3, 20)
	// Chat messages per user.
	messageLimit = newLimiter(2, 10)
	// Pages fetched for link previews (cache misses only) per user.
	previewLimit = newLimiter(0.5, 20)
	// Desktop sign-ins started, for everyone together: nobody is signed in yet to tell them apart.
	desktopStartLimit = newLimiter(1.0/3, 20)
)

func tooMany(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, "slow down a little", http.StatusTooManyRequests)
}
