package com.najme.shenavatest

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.inputmethodservice.InputMethodService
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputConnection
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineNeMoCtcModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.max

class ShenavaImeService : InputMethodService() {
    companion object {
        private const val SAMPLE_RATE = 16000
        private const val CHUNK_SAMPLES = 1600 // 100 ms
    }

    private val main = Handler(Looper.getMainLooper())
    private val generation = AtomicInteger(0)
    private val modelLock = Any()

    @Volatile private var modelReady = false
    @Volatile private var modelLoading = false
    @Volatile private var modelError: String? = null
    private var recognizer: OnlineRecognizer? = null

    @Volatile private var voiceActive = false
    @Volatile private var finalizeRequested = false
    @Volatile private var recordingThread: Thread? = null
    @Volatile private var audioRecord: AudioRecord? = null

    private var statusView: TextView? = null
    private var micButton: Button? = null

    private fun dp(value: Float): Int = (value * resources.displayMetrics.density).toInt()

    override fun onCreate() {
        super.onCreate()
        initModelAsync()
    }

    override fun onCreateInputView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(5f), dp(5f), dp(5f), dp(6f))
            setBackgroundColor(Color.rgb(239, 239, 244))
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }

        micButton = keyButton("🎙").apply {
            textSize = 22f
            setOnClickListener { toggleVoice() }
        }
        bar.addView(micButton, LinearLayout.LayoutParams(dp(58f), dp(48f)))

        statusView = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(45, 45, 52))
            gravity = Gravity.RIGHT or Gravity.CENTER_VERTICAL
            textDirection = View.TEXT_DIRECTION_RTL
            setPadding(dp(8f), 0, dp(8f), 0)
        }
        bar.addView(statusView, LinearLayout.LayoutParams(0, dp(48f), 1f))

        val globe = keyButton("🌐").apply {
            textSize = 20f
            setOnClickListener { switchToNextInputMethod(false) }
        }
        bar.addView(globe, LinearLayout.LayoutParams(dp(54f), dp(48f)))
        root.addView(bar, LinearLayout.LayoutParams(-1, dp(50f)))

        addLetterRow(root, arrayOf("ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج", "چ"))
        addLetterRow(root, arrayOf("ش", "س", "ی", "ب", "ل", "ا", "ت", "ن", "م", "ک", "گ"))
        addLetterRow(root, arrayOf("ظ", "ط", "ز", "ر", "ذ", "د", "پ", "و", ".", "،", "؟"))

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }

        val backspace = keyButton("⌫").apply {
            setOnClickListener {
                cancelVoiceForManualInput()
                currentInputConnection?.deleteSurroundingText(1, 0)
            }
        }
        bottom.addView(backspace, LinearLayout.LayoutParams(0, dp(46f), 1.2f))

        val zwnj = keyButton("نیم‌فاصله").apply {
            textSize = 12f
            setOnClickListener { commitManual("\u200c") }
        }
        bottom.addView(zwnj, LinearLayout.LayoutParams(0, dp(46f), 1.6f))

        val space = keyButton("فاصله").apply {
            textSize = 13f
            setOnClickListener { commitManual(" ") }
        }
        bottom.addView(space, LinearLayout.LayoutParams(0, dp(46f), 3.2f))

        val enter = keyButton("↵").apply {
            textSize = 20f
            setOnClickListener { commitManual("\n") }
        }
        bottom.addView(enter, LinearLayout.LayoutParams(0, dp(46f), 1.2f))
        root.addView(bottom, LinearLayout.LayoutParams(-1, dp(48f)))

        refreshStatus()
        return root
    }

    private fun addLetterRow(root: LinearLayout, labels: Array<String>) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        labels.forEach { label ->
            val button = keyButton(label).apply { setOnClickListener { commitManual(label) } }
            row.addView(button, LinearLayout.LayoutParams(0, dp(44f), 1f))
        }
        root.addView(row, LinearLayout.LayoutParams(-1, dp(46f)))
    }

    private fun keyButton(label: String): Button = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 17f
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = 0
        setPadding(dp(1f), 0, dp(1f), 0)
    }

    private fun commitManual(value: String) {
        cancelVoiceForManualInput()
        currentInputConnection?.commitText(value, 1)
    }

    private fun cancelVoiceForManualInput() {
        if (voiceActive || recordingThread?.isAlive == true) stopVoice(false)
        currentInputConnection?.finishComposingText()
    }

    private fun toggleVoice() {
        if (voiceActive) stopVoice(true) else startVoice()
    }

    private fun startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus("مجوز میکروفون لازم است — اپ Shenava Keyboard Test را باز کنید")
            return
        }
        if (!modelReady) {
            modelError?.let { setStatus("خطای مدل: $it") } ?: setStatus("مدل شنوا هنوز در حال آماده‌شدن است…")
            initModelAsync()
            return
        }
        if (recordingThread?.isAlive == true) {
            setStatus("یک لحظه… نشست قبلی در حال بسته‌شدن است")
            return
        }

        val gen = generation.incrementAndGet()
        finalizeRequested = false
        voiceActive = true
        updateMicVisual(true)
        setStatus("شنوا محلی — در حال گوش‌دادن")
        recordingThread = thread(start = true, name = "shenava-local-asr") { runRecognition(gen) }
    }

    private fun stopVoice(finalizeText: Boolean) {
        if (!voiceActive && recordingThread?.isAlive != true) return
        finalizeRequested = finalizeText
        voiceActive = false
        if (!finalizeText) generation.incrementAndGet()
        updateMicVisual(false)
        try { audioRecord?.stop() } catch (_: Throwable) {}
        setStatus(if (finalizeText) "در حال نهایی‌کردن متن…" else "آماده")
    }

    private fun runRecognition(gen: Int) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        var localStream: OnlineStream? = null
        var localRecord: AudioRecord? = null
        var lastText = ""
        try {
            synchronized(modelLock) {
                localStream = recognizer?.createStream("")
                    ?: throw IllegalStateException("recognizer unavailable")
            }

            val minBytes = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val bufferBytes = max(minBytes, CHUNK_SAMPLES * 2 * 4)
            localRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes
            )
            if (localRecord.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("AudioRecord init failed")
            audioRecord = localRecord
            localRecord.startRecording()

            val pcm = ShortArray(CHUNK_SAMPLES)
            while (voiceActive && gen == generation.get()) {
                val n = localRecord.read(pcm, 0, pcm.size)
                if (n <= 0) continue
                val samples = FloatArray(n) { i -> pcm[i] / 32768.0f }
                val start = System.nanoTime()
                val text: String
                synchronized(modelLock) {
                    localStream!!.acceptWaveform(samples, SAMPLE_RATE)
                    while (recognizer!!.isReady(localStream!!)) recognizer!!.decode(localStream!!)
                    text = recognizer!!.getResult(localStream!!).text.trim()
                }
                val decodeMs = (System.nanoTime() - start) / 1_000_000L
                if (text != lastText) {
                    lastText = text
                    publishPartial(text, gen, decodeMs)
                } else {
                    publishLatencyOnly(gen, decodeMs)
                }
            }

            val shouldFinalize = finalizeRequested && gen == generation.get()
            if (shouldFinalize) {
                val finalText: String
                synchronized(modelLock) {
                    localStream!!.acceptWaveform(FloatArray((SAMPLE_RATE * 0.35f).toInt()), SAMPLE_RATE)
                    localStream!!.inputFinished()
                    while (recognizer!!.isReady(localStream!!)) recognizer!!.decode(localStream!!)
                    finalText = recognizer!!.getResult(localStream!!).text.trim()
                }
                publishFinal(finalText, gen)
            }
        } catch (e: Throwable) {
            if (gen == generation.get()) {
                setStatus("خطای شنوا: ${safeMessage(e)}")
                updateMicVisual(false)
            }
        } finally {
            try { localRecord?.stop() } catch (_: Throwable) {}
            try { localRecord?.release() } catch (_: Throwable) {}
            audioRecord = null
            try { localStream?.release() } catch (_: Throwable) {}
            if (recordingThread === Thread.currentThread()) recordingThread = null
            if (gen == generation.get()) {
                voiceActive = false
                finalizeRequested = false
                updateMicVisual(false)
            }
        }
    }

    private fun publishPartial(text: String, gen: Int, decodeMs: Long) {
        main.post {
            if (!voiceActive || gen != generation.get()) return@post
            currentInputConnection?.setComposingText(text, 1)
            statusView?.text = "شنوا محلی • $decodeMs ms"
        }
    }

    private fun publishLatencyOnly(gen: Int, decodeMs: Long) {
        main.post {
            if (!voiceActive || gen != generation.get()) return@post
            statusView?.text = "شنوا محلی • $decodeMs ms"
        }
    }

    private fun publishFinal(text: String, gen: Int) {
        main.post {
            if (gen != generation.get()) return@post
            currentInputConnection?.let { ic: InputConnection ->
                if (text.isNotEmpty()) ic.setComposingText(text, 1)
                ic.finishComposingText()
            }
            setStatus("آماده — متن روی خود گوشی پردازش شد")
        }
    }

    private fun initModelAsync() {
        if (modelReady || modelLoading) return
        modelLoading = true
        modelError = null
        setStatus("در حال آماده‌سازی مدل محلی شنوا…")
        thread(start = true, name = "shenava-model-init") {
            try {
                val modelConfig = OnlineModelConfig(
                    neMoCtc = OnlineNeMoCtcModelConfig(model = "shenava/model.int8.onnx"),
                    tokens = "shenava/tokens.txt",
                    numThreads = 4,
                    debug = false,
                    provider = "cpu"
                )
                val config = OnlineRecognizerConfig(
                    featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80, dither = 0.0f),
                    modelConfig = modelConfig,
                    enableEndpoint = false,
                    decodingMethod = "greedy_search"
                )
                val newRecognizer = OnlineRecognizer(assetManager = assets, config = config)
                synchronized(modelLock) {
                    try { recognizer?.release() } catch (_: Throwable) {}
                    recognizer = newRecognizer
                }
                modelReady = true
                setStatus("آماده — Shenava Rizeh محلی")
            } catch (e: Throwable) {
                modelError = safeMessage(e)
                setStatus("خطای بارگذاری مدل: $modelError")
            } finally {
                modelLoading = false
            }
        }
    }

    private fun safeMessage(e: Throwable): String {
        val message = e.message?.trim().orEmpty()
        if (message.isEmpty()) return e.javaClass.simpleName
        return if (message.length > 120) message.substring(0, 120) else message
    }

    private fun setStatus(value: String) {
        main.post { statusView?.text = value }
    }

    private fun refreshStatus() {
        when {
            modelError != null -> setStatus("خطای مدل: $modelError")
            modelReady -> setStatus("آماده — Shenava Rizeh محلی")
            else -> setStatus("در حال آماده‌سازی مدل محلی شنوا…")
        }
    }

    private fun updateMicVisual(active: Boolean) {
        main.post { micButton?.text = if (active) "■" else "🎙" }
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        stopVoice(false)
        super.onFinishInputView(finishingInput)
    }

    override fun onFinishInput() {
        stopVoice(false)
        super.onFinishInput()
    }

    override fun onWindowHidden() {
        stopVoice(false)
        super.onWindowHidden()
    }

    override fun onDestroy() {
        stopVoice(false)
        val old: OnlineRecognizer?
        synchronized(modelLock) {
            old = recognizer
            recognizer = null
        }
        try { old?.release() } catch (_: Throwable) {}
        super.onDestroy()
    }
}
