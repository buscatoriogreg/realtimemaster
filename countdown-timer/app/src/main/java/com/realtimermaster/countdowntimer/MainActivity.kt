package com.realtimermaster.countdowntimer

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.util.Locale

data class DurationOption(val label: String, val seconds: Int)

private val DURATIONS = listOf(
    DurationOption("2:00", 120),
    DurationOption("1:00", 60),
    DurationOption("0:45", 45),
    DurationOption("0:30", 30),
)

class MainActivity : ComponentActivity() {
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the screen on for the entire lifetime of the app.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.US
            }
        }
        setContent {
            MaterialTheme {
                Surface {
                    CountdownScreen(onRiderReady = { speakRiderReady() })
                }
            }
        }
    }

    private fun speakRiderReady() {
        tts?.speak("Rider Ready", TextToSpeech.QUEUE_FLUSH, null, "rider_ready")
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }
}

@Composable
fun CountdownScreen(onRiderReady: () -> Unit) {
    var selected by remember { mutableStateOf(DURATIONS[1]) }
    var remaining by remember { mutableStateOf(selected.seconds) }
    var isRunning by remember { mutableStateOf(false) }

    val beeper = remember { Beeper() }
    DisposableEffect(Unit) {
        onDispose { beeper.release() }
    }

    LaunchedEffect(isRunning, selected) {
        if (isRunning) {
            while (true) {
                delay(1000L)
                when {
                    remaining > 1 -> {
                        remaining -= 1
                        if (remaining in 1..10) {
                            beeper.playShortBeep()
                        }
                    }
                    remaining == 1 -> {
                        remaining = 0
                        beeper.playFinalBeep()
                    }
                    else -> {
                        // Zero was just shown for one tick; start the next lap.
                        remaining = selected.seconds
                        onRiderReady()
                    }
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(text = "Select duration", style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DURATIONS.forEach { option ->
                FilterChip(
                    selected = selected == option,
                    enabled = !isRunning,
                    onClick = {
                        selected = option
                        remaining = option.seconds
                    },
                    label = { Text(option.label) }
                )
            }
        }

        Spacer(modifier = Modifier.height(48.dp))

        val minutes = remaining / 60
        val secs = remaining % 60
        Text(
            text = "%d:%02d".format(minutes, secs),
            fontSize = 72.sp,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(48.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Button(onClick = {
                if (!isRunning) onRiderReady()
                isRunning = !isRunning
            }) {
                Text(if (isRunning) "Pause" else "Start")
            }
            OutlinedButton(onClick = {
                isRunning = false
                remaining = selected.seconds
            }) {
                Text("Reset")
            }
        }
    }
}
