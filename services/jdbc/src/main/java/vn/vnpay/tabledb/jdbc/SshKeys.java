package vn.vnpay.tabledb.jdbc;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;

/**
 * SSH private keys imported by the desktop into an app-data directory passed at start-up (--ssh-keys). A request only
 * names a key by id ({@link Profile#KEY_ID}); the file is {@code <dir>/<id>.key}. Paths never come from a request, and
 * key bytes are never returned or logged.
 */
public final class SshKeys {
    public static final long MAX_KEY_BYTES = 64 * 1024;
    private final Path dir;

    public SshKeys(Path dir) { this.dir = dir; }

    public static SshKeys none() { return new SshKeys(null); }

    public byte[] read(String keyId) {
        if (keyId == null || !Profile.KEY_ID.matcher(keyId).matches()) throw RpcError.badRequest("invalid ssh key id");
        if (dir == null) throw new RpcError("E_NOT_FOUND", "SSH key store is not available");
        try {
            Path base = dir.toRealPath();
            Path f = base.resolve(keyId + ".key");
            if (!Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS) || !f.toRealPath().getParent().equals(base))
                throw new RpcError("E_NOT_FOUND", "SSH key '" + keyId + "' not found (import it again)");
            if (Files.size(f) > MAX_KEY_BYTES) throw RpcError.badRequest("SSH key file is too large");
            return Files.readAllBytes(f);
        } catch (IOException e) {
            throw new RpcError("E_NOT_FOUND", "SSH key '" + keyId + "' not found (import it again)");
        }
    }
}
