package app.tasksng.android.data

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

class WebLinkException(message: String) : Exception(message)

/** What a pairing code (QR or typed) says. */
data class PairingCode(
    /** The web app's address, without a trailing slash. */
    val baseUrl: String,
    val code: String,
    /** `pair`: link this phone. `login`: sign a browser in. */
    val mode: String,
) {
    val host: String get() = Uri.parse(baseUrl).host ?: baseUrl
    val secure: Boolean get() = baseUrl.startsWith("https://")
}

@Serializable
data class PairedAccount(val serverUrl: String, val username: String, val password: String, val acceptInvalidCerts: Boolean = false)

@Serializable
data class ClaimResult(val deviceId: String, val token: String, val account: PairedAccount? = null)

@Serializable
data class WebInfo(val version: String = "", val pairing: Boolean = false, val name: String? = null)

/** Talks to a TasksNG web app (`tasksng-server`) this phone is, or is being, paired with. */
object WebLink {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Reads what the web app shows as a QR code: `https://host/pair?c=CODE`
     * (or `…/pair?c=CODE&m=login`). A `tasksng://pair?u=…&c=…` link works too.
     */
    fun parse(text: String): PairingCode? {
        val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
        val code = uri.getQueryParameter("c")?.let(::normalizeCode) ?: return null
        val mode = if (uri.getQueryParameter("m") == "login") "login" else "pair"
        if (uri.scheme == "tasksng") {
            val base = uri.getQueryParameter("u") ?: return null
            return PairingCode(normalizeBase(base) ?: return null, code, mode)
        }
        if (uri.scheme != "http" && uri.scheme != "https") return null
        val path = uri.path.orEmpty().trimEnd('/')
        if (!path.endsWith("/pair")) return null
        val prefix = path.removeSuffix("/pair")
        val port = if (uri.port > 0) ":${uri.port}" else ""
        return PairingCode("${uri.scheme}://${uri.host}$port$prefix", code, mode)
    }

    /** Codes are shown as `ABCD-EFGH`; typing them without the dash or in lower case is fine. */
    fun normalizeCode(code: String): String? {
        val c = code.uppercase().filter { it.isLetterOrDigit() }
        return if (c.length in 6..16) c else null
    }

    /** `tasks.example.com` → `https://tasks.example.com`; a bare IP address or `localhost` gets `http`. */
    fun normalizeBase(input: String): String? {
        var s = input.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (!s.contains("://")) {
            val host = s.substringBefore('/').substringBefore(':')
            val local = host == "localhost" || host.all { it.isDigit() || it == '.' } || host.endsWith(".local") || !host.contains('.')
            s = (if (local) "http://" else "https://") + s
        }
        val uri = runCatching { Uri.parse(s) }.getOrNull() ?: return null
        if (uri.host.isNullOrEmpty() || (uri.scheme != "http" && uri.scheme != "https")) return null
        return s
    }

    private fun request(method: String, url: String, body: JsonObject? = null, token: String? = null): JsonObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 30_000
            setRequestProperty("X-TasksNG", "android")
            setRequestProperty("Accept", "application/json")
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            val parsed = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            if (status !in 200..299) {
                throw WebLinkException(parsed?.get("error")?.jsonPrimitive?.content ?: "The web app answered with an error ($status)")
            }
            return parsed ?: JsonObject(emptyMap())
        } catch (e: WebLinkException) {
            throw e
        } catch (e: javax.net.ssl.SSLException) {
            throw WebLinkException("The web app's certificate isn't trusted (${e.message})")
        } catch (e: java.io.IOException) {
            throw WebLinkException("Can't reach the web app (${e.message ?: e.javaClass.simpleName})")
        } finally {
            conn.disconnect()
        }
    }

    suspend fun info(baseUrl: String): WebInfo = withContext(Dispatchers.IO) {
        json.decodeFromJsonElement(WebInfo.serializer(), request("POST", "$baseUrl/api/server_info", JsonObject(emptyMap())))
    }

    /** Links this phone using the code a signed-in browser shows; answers the account to sign in to. */
    suspend fun claim(code: PairingCode, deviceName: String): ClaimResult = withContext(Dispatchers.IO) {
        val out = request("POST", "${code.baseUrl}/api/pair/claim", buildJsonObject {
            put("code", code.code)
            put("deviceName", deviceName)
            put("platform", "android")
        })
        json.decodeFromJsonElement(ClaimResult.serializer(), out)
    }

    /**
     * Signs in the browser that shows [code]. With [token] the web app knows
     * this phone already; without it the phone's own account is sent, which
     * also links the phone.
     */
    suspend fun approveLogin(code: PairingCode, token: String?, account: PairedAccount?, deviceName: String): ClaimResult? =
        withContext(Dispatchers.IO) {
            val out = request("POST", "${code.baseUrl}/api/pair/approve", buildJsonObject {
                put("code", code.code)
                put("deviceName", deviceName)
                put("platform", "android")
                if (token == null && account != null) put("account", buildJsonObject {
                    put("serverUrl", account.serverUrl)
                    put("username", account.username)
                    put("password", account.password)
                    put("acceptInvalidCerts", account.acceptInvalidCerts)
                })
            }, token)
            if (out.containsKey("token")) json.decodeFromJsonElement(ClaimResult.serializer(), out) else null
        }

    /** Tells the web app this phone changed something, so open browser tabs refresh at once. */
    suspend fun poke(baseUrl: String, token: String) = withContext(Dispatchers.IO) {
        request("POST", "$baseUrl/api/device/poke", JsonObject(emptyMap()), token)
        Unit
    }

    suspend fun unlink(baseUrl: String, token: String) = withContext(Dispatchers.IO) {
        request("POST", "$baseUrl/api/device/unlink", JsonObject(emptyMap()), token)
        Unit
    }

    /**
     * Listens to the web app's live updates (Server-Sent Events) until the
     * connection ends. [onEvent] gets each event's name: `changed` when the
     * account changed in a browser, `unlinked` when this phone was removed.
     * Answers the HTTP status when the web app refuses (401: no longer paired).
     */
    fun listen(baseUrl: String, token: String, onOpen: () -> Unit, onEvent: (String) -> Unit): Int {
        val conn = (URL("$baseUrl/api/device/events").openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            // The web app sends a keep-alive every 20 seconds.
            readTimeout = 60_000
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("X-TasksNG", "android")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            val status = conn.responseCode
            if (status != 200) return status
            onOpen()
            conn.inputStream.bufferedReader().use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.startsWith("event:")) onEvent(line.substring(6).trim())
                }
            }
            return 200
        } finally {
            conn.disconnect()
        }
    }
}
