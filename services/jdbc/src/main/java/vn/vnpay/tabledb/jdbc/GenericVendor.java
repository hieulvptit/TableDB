package vn.vnpay.tabledb.jdbc;

import java.util.Properties;

/**
 * Vendor for user-imported ("custom") drivers. The URL comes from the driver's manifest urlTemplate with ONLY the
 * validated host/port/database substituted; credentials and options go through properties. DDL is synthesized.
 */
public final class GenericVendor extends Vendor {
    private final DriverRegistry registry;

    public GenericVendor(DriverRegistry registry) { this.registry = registry; }

    @Override public String type() { return "custom"; }

    @Override public String url(Profile p) {
        DriverRegistry.CustomInfo i = registry.customInfo(p.driverId);
        if (i == null) throw new RpcError("E_DRIVER_UNAVAILABLE", "custom JDBC driver '" + p.driverId + "' is not available");
        return i.urlTemplate()
                .replace("{host}", p.host)
                .replace("{port}", Integer.toString(p.port))
                .replace("{database}", p.database == null ? "" : p.database);
    }

    @Override public Properties props(Profile p) {
        Properties pr = new Properties();
        pr.setProperty("user", p.username);
        pr.setProperty("password", p.password == null ? "" : p.password);
        return pr;
    }
}
