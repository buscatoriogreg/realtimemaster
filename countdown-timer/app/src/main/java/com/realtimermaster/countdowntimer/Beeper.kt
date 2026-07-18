package com.realtimermaster.countdowntimer

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * Generates and plays short beep tones via AudioTrack (USAGE_MEDIA).
 *
 * ToneGenerator routes through the telephony/DTMF tone-mixer path, which many
 * devices don't forward to a connected Bluetooth A2DP speaker. AudioTrack with
 * USAGE_MEDIA uses the normal media audio path, so it follows whatever output
 * (phone speaker or Bluetooth) is currently active.
 */
class Beeper {
    private val sampleRate = 44100
    private val shortBeep = buildTone(frequencyHz = 1500, durationMs = 300)
    private val finalBeep = buildTone(frequencyHz = 900, durationMs = 1000)

    private fun buildTone(frequencyHz: Int, durationMs: Int): AudioTrack {
        val numSamples = sampleRate * durationMs / 1000
        val fadeSamples = (sampleRate * 0.005).toInt().coerceAtLeast(1)
        val buffer = ShortArray(numSamples)
        for (i in 0 until numSamples) {
            val angle = 2.0 * PI * i * frequencyHz / sampleRate
            val fadeIn = min(i.toDouble() / fadeSamples, 1.0)
            val fadeOut = min((numSamples - i).toDouble() / fadeSamples, 1.0)
            val envelope = min(fadeIn, fadeOut)
            buffer[i] = (sin(angle) * envelope * Short.MAX_VALUE * 0.9).toInt().toShort()
        }

        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val format = AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()

        val track = AudioTrack(
            attributes,
            format,
            buffer.size * 2,
            AudioTrack.MODE_STATIC,
            AudioManager.AUDIO_SESSION_ID_GENERATE
        )
        track.write(buffer, 0, buffer.size)
        return track
    }

    fun playShortBeep() = replay(shortBeep)

    fun playFinalBeep() = replay(finalBeep)

    private fun replay(track: AudioTrack) {
        track.stop()
        track.setPlaybackHeadPosition(0)
        track.play()
    }

    fun release() {
        shortBeep.release()
        finalBeep.release()
    }
}
