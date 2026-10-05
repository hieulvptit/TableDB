package vn.vnpay.tabledb.jdbc;

import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.Properties;
import java.util.logging.Logger;

/**
 * Wraps a Driver that lives in a private URLClassLoader so we can call it without registering it in
 * DriverManager (which ignores drivers from foreign class loaders and is JVM-global).
 */
public final class DriverShim implements Driver {
    private final Driver delegate;

    public DriverShim(Driver delegate) { this.delegate = delegate; }

    public ClassLoader loader() { return delegate.getClass().getClassLoader(); }

    @Override public Connection connect(String url, Properties info) throws SQLException { return delegate.connect(url, info); }
    @Override public boolean acceptsURL(String url) throws SQLException { return delegate.acceptsURL(url); }
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException { return delegate.getPropertyInfo(url, info); }
    @Override public int getMajorVersion() { return delegate.getMajorVersion(); }
    @Override public int getMinorVersion() { return delegate.getMinorVersion(); }
    @Override public boolean jdbcCompliant() { return delegate.jdbcCompliant(); }
    @Override public Logger getParentLogger() throws SQLFeatureNotSupportedException { return delegate.getParentLogger(); }
}
