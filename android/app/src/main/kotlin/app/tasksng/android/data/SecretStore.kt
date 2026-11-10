package app.tasksng.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Passwords and device tokens, encrypted with a key that lives in the
 * Android Keystore and never leaves the device (it isn't part of backups).
 */
class SecretStore(context: Context) {
    private val prefs = context.getSharedPreferences("tasksng-secrets", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    /** Stores a value. Answers false when the Keystore isn't usable; the value is then asked for again next time. */
    fun put(name: String, value: String): Boolean = runCatching {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val data = cipher.iv + cipher.doFinal(value.toByteArray())
        prefs.edit().putString(name, Base64.encodeToString(data, Base64.NO_WRAP)).apply()
    }.isSuccess

    /** The stored value, or null when there is none or it can't be read any more (restored backup, new device). */
    fun get(name: String): String? {
        val raw = prefs.getString(name, null) ?: return null
        return runCatching {
            val data = Base64.decode(raw, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, IV_SIZE))
            String(cipher.doFinal(data, IV_SIZE, data.size - IV_SIZE))
        }.getOrNull()
    }

    fun remove(name: String) {
        prefs.edit().remove(name).apply()
    }

    companion object {
        private const val ALIAS = "tasksng-secrets"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_SIZE = 12
        const val PASSWORD = "password"
        fun deviceToken(serverId: String) = "device-token:$serverId"
    }
}
