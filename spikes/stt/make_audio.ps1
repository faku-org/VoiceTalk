# Spanish test utterances via Windows SAPI (Helena, es-ES). Output: out/tts/*.wav
# Saved as UTF-8 with BOM: Windows PowerShell 5 reads BOM-less files as ANSI and SAPI would speak the mojibake.
param([string]$Out = "out/tts")
Add-Type -AssemblyName System.Speech
$lines = @{
  "ref" = "Hola, soy la voz de referencia. Estoy leyendo un texto tranquilo para que el modelo aprenda cómo hablo, con pausas naturales y un ritmo pausado.";
  "u1"  = "Hola, ¿cómo estás? Me llamo Faku.";
  "u2"  = "Estoy probando una aplicación de voz que armé. ¿Qué te parece la idea de charlar con una computadora?";
  "u3"  = "Contame algo interesante sobre la historia de Buenos Aires.";
  "u4"  = "Che, ¿te acordás cómo se llama mi perro?"
}
foreach ($k in $lines.Keys) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice("Microsoft Helena Desktop")
  $s.Rate = 0
  $s.SetOutputToWaveFile((Join-Path (Resolve-Path $Out) "$k.wav"))
  $s.Speak($lines[$k])
  $s.Dispose()
}
