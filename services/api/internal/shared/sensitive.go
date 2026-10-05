package shared

import "regexp"

// SensitiveCounts are COUNTS of simple sensitive-looking patterns found in a text line. Values are never kept.
type SensitiveCounts struct {
	Phone    int `json:"phone"`
	Email    int `json:"email"`
	IDNumber int `json:"idNumber"` // 9 or 12 consecutive digits (CMND / CCCD like)
	Card     int `json:"card"`     // 13..19 digits passing the Luhn check
}

func (c *SensitiveCounts) Add(o SensitiveCounts) {
	c.Phone += o.Phone
	c.Email += o.Email
	c.IDNumber += o.IDNumber
	c.Card += o.Card
}

func (c SensitiveCounts) Any() bool { return c.Phone+c.Email+c.IDNumber+c.Card > 0 }

var reCardCandidate = regexp.MustCompile(`(?:\d[ -]?){13,19}\b`)

func luhn(digits []byte) bool {
	sum, alt := 0, false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}

// CountSensitive counts VN phone numbers, e-mail addresses, 9/12-digit id numbers and Luhn-valid card numbers in one line.
// It reuses the redaction patterns (same phone matcher and e-mail regexp) but returns counts only.
func CountSensitive(line []byte) SensitiveCounts {
	var c SensitiveCounts
	s := string(line)
	c.Email = len(reEmail.FindAllStringIndex(s, -1))
	for i := 0; i < len(s); {
		if end := matchPhone(s, i); end > i {
			c.Phone++
			i = end
			continue
		}
		i++
	}
	for i := 0; i < len(s); {
		if !isDigit(s[i]) {
			i++
			continue
		}
		j := i
		for j < len(s) && isDigit(s[j]) {
			j++
		}
		if n := j - i; n == 9 || n == 12 {
			c.IDNumber++
		}
		i = j
	}
	for _, loc := range reCardCandidate.FindAllStringIndex(s, -1) {
		if loc[0] > 0 && isDigit(s[loc[0]-1]) {
			continue // the tail of a longer digit run is not a card number
		}
		m := s[loc[0]:loc[1]]
		d := make([]byte, 0, 19)
		for k := 0; k < len(m); k++ {
			if isDigit(m[k]) {
				d = append(d, m[k])
			}
		}
		if len(d) >= 13 && len(d) <= 19 && luhn(d) {
			c.Card++
		}
	}
	return c
}
