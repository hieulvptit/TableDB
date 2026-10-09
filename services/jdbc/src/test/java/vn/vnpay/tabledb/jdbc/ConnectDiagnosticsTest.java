package vn.vnpay.tabledb.jdbc;

import java.net.UnknownHostException;
import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ConnectDiagnosticsTest {
    @Test void retainsTransportCauseAndSqlStateWithoutSecrets() {
        SQLException error = new SQLException("Cannot authenticate password=secret-pass", "08001", 42,
                new UnknownHostException("query-engine-staging.vnpayapi.vn"));
        error.setNextException(new SQLException("proxy refused secret-pass"));
        var causes = ConnectDiagnostics.causes(error, "secret-pass");
        String text = Json.write(causes);
        assertTrue(text.contains("UnknownHostException"));
        assertTrue(text.contains("query-engine-staging.vnpayapi.vn"));
        assertTrue(text.contains("08001"));
        assertTrue(text.contains("proxy refused"));
        assertFalse(text.contains("secret-pass"));
    }

    @Test void logsRouteTlsAndAuthWithoutProfileCredentials() {
        Profile p = ProfileTest.parse(ProfileTest.pg());
        var fields = ConnectDiagnostics.fields(p, "t_123", "jdbc_connect", System.nanoTime());
        assertEquals("direct", fields.get("route"));
        assertEquals("password", fields.get("auth_type"));
        assertFalse(fields.containsKey("password"));
        assertFalse(fields.containsKey("username"));
    }

    @Test void stripsUnknownAuthenticationQueryParameters() {
        assertEquals("https://trino/oauth2/callback?***", Redactor.scrub("https://trino/oauth2/callback?ticket=private&nonce=nonce"));
    }
}
