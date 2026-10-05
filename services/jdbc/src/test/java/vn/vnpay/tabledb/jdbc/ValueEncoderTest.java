package vn.vnpay.tabledb.jdbc;

import static org.junit.jupiter.api.Assertions.*;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Timestamp;
import java.time.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ValueEncoderTest {
    @Test void safeIntegersAreNumbers() {
        assertEquals(5L, ValueEncoder.encode(5));
        assertEquals(5L, ValueEncoder.encode((short) 5));
        assertEquals(ValueEncoder.MAX_SAFE, ValueEncoder.encode(ValueEncoder.MAX_SAFE));
        assertEquals(-ValueEncoder.MAX_SAFE, ValueEncoder.encode(-ValueEncoder.MAX_SAFE));
    }

    @Test void unsafeBigintAndDecimalAreStrings() {
        assertEquals("9007199254740992", ValueEncoder.encode(9007199254740992L));
        assertEquals("9223372036854775807", ValueEncoder.encode(Long.MAX_VALUE));
        assertEquals("123456789012345678901234567890", ValueEncoder.encode(new BigInteger("123456789012345678901234567890")));
        assertEquals("12.500", ValueEncoder.encode(new BigDecimal("12.500")));
        assertEquals("100000000", ValueEncoder.encode(new BigDecimal("1E+8")));
    }

    @Test void floatingPoint() {
        assertEquals(1.5, ValueEncoder.encode(1.5));
        assertEquals("NaN", ValueEncoder.encode(Double.NaN));
        assertEquals("Infinity", ValueEncoder.encode(Double.POSITIVE_INFINITY));
        assertEquals(0.1, ValueEncoder.encode(0.1f));
    }

    @Test void temporalAreIso8601() {
        assertEquals("2024-02-29", ValueEncoder.encode(java.sql.Date.valueOf("2024-02-29")));
        assertEquals("10:15:30", ValueEncoder.encode(java.sql.Time.valueOf("10:15:30")));
        assertEquals("2024-02-29T10:15:30", ValueEncoder.encode(Timestamp.valueOf("2024-02-29 10:15:30")));
        assertEquals("2024-02-29T10:15:30.123456", ValueEncoder.encode(Timestamp.valueOf("2024-02-29 10:15:30.123456")));
        assertEquals("2024-02-29T10:15:30+07:00", ValueEncoder.encode(OffsetDateTime.of(2024, 2, 29, 10, 15, 30, 0, ZoneOffset.ofHours(7))));
        assertEquals("2024-02-29T00:00:00Z", ValueEncoder.encode(Instant.parse("2024-02-29T00:00:00Z")));
        assertEquals("2024-02-29", ValueEncoder.encode(LocalDate.of(2024, 2, 29)));
    }

    @Test void binaryIsBase64CappedAt256WithLength() {
        byte[] small = {1, 2, 3};
        @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) ValueEncoder.encode(small);
        assertEquals("AQID", m.get("$binary"));
        assertEquals(3L, m.get("length"));
        byte[] big = new byte[1000];
        @SuppressWarnings("unchecked") Map<String, Object> b = (Map<String, Object>) ValueEncoder.encode(big);
        assertEquals(1000L, b.get("length"));
        assertEquals(256, java.util.Base64.getDecoder().decode((String) b.get("$binary")).length);
    }

    @Test void nullBooleanTextAndFallbacks() {
        assertNull(ValueEncoder.encode(null));
        assertEquals(true, ValueEncoder.encode(true));
        assertEquals("héllo", ValueEncoder.encode("héllo"));
        assertEquals("00000000-0000-0000-0000-000000000001", ValueEncoder.encode(new java.util.UUID(0, 1)));
        assertEquals(List.of(1L, "a"), ValueEncoder.encode(new Object[] {1, "a"}));
        // everything encodable is serializable
        assertDoesNotThrow(() -> Json.write(ValueEncoder.encode(new StringBuilder("x"))));
    }
}
