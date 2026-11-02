package dev.arnv.bluke.bluetooth

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException

/**
 * Receives only the active Windows keyboard-layout identifier.
 * Keystrokes remain on Bluetooth HID; this channel never carries typed text.
 */
class HostLanguageServer {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _layoutPreference = MutableStateFlow<String?>(null)
    val layoutPreference: StateFlow<String?> = _layoutPreference.asStateFlow()

    private val lock = Any()

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var clientSocket: Socket? = null

    private var serverJob: Job? = null

    fun start() {
        synchronized(lock) {
            if (serverJob?.isActive == true) return
            serverJob = scope.launch { runServer() }
        }
    }

    private suspend fun runServer() {
        while (isActive) {
            var server: ServerSocket? = null
            try {
                server = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), PORT), 2)
                }
                serverSocket = server
                Log.i(TAG, "Host-language bridge listening on port $PORT")

                while (isActive) {
                    val client = server.accept()
                    clientSocket = client
                    try {
                        handleClient(client)
                    } catch (e: SocketException) {
                        if (isActive) Log.i(TAG, "Host-language client disconnected")
                    } catch (e: Exception) {
                        if (isActive) Log.w(TAG, "Host-language client error", e)
                    } finally {
                        clientSocket = null
                        runCatching { client.close() }
                    }
                }
            } catch (e: SocketException) {
                if (isActive) {
                    Log.w(TAG, "Host-language server socket closed; retrying", e)
                    delay(RETRY_DELAY_MS)
                }
            } catch (e: Exception) {
                if (isActive) {
                    Log.w(TAG, "Host-language server could not start; retrying", e)
                    delay(RETRY_DELAY_MS)
                }
            } finally {
                runCatching { server?.close() }
                if (serverSocket === server) serverSocket = null
            }
        }
    }

    private fun handleClient(client: Socket) {
        client.tcpNoDelay = true
        val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.UTF_8))
        val writer = BufferedWriter(OutputStreamWriter(client.getOutputStream(), Charsets.UTF_8))

        while (!client.isClosed) {
            val line = reader.readLine() ?: break
            if (line.length > MAX_MESSAGE_LENGTH) break

            val layout = parseLayoutPreference(line)
            val response = JSONObject()
            if (layout != null) {
                _layoutPreference.value = layout
                response.put("ok", true)
                response.put("layout", layout)
            } else {
                response.put("ok", false)
            }

            writer.write(response.toString())
            writer.newLine()
            writer.flush()
        }
    }

    internal fun parseLayoutPreference(line: String): String? = runCatching {
        val payload = JSONObject(line)
        if (payload.optString("protocol") != PROTOCOL) return null
        payload.optString("layout").takeIf(SUPPORTED_LAYOUTS::contains)
    }.getOrNull()

    fun stop() {
        synchronized(lock) {
            runCatching { clientSocket?.close() }
            runCatching { serverSocket?.close() }
            clientSocket = null
            serverSocket = null
            serverJob?.cancel()
            serverJob = null
        }
    }

    companion object {
        const val PORT = 39472
        private const val TAG = "BlukeHostLanguage"
        private const val PROTOCOL = "bluke-language-v1"
        private const val MAX_MESSAGE_LENGTH = 1024
        private const val RETRY_DELAY_MS = 1500L
        private val SUPPORTED_LAYOUTS = setOf(
            "us_qwerty",
            "fr_azerty",
            "de_qwertz",
            "ru_jcuken",
            "fa_persian_standard",
        )
    }
}
