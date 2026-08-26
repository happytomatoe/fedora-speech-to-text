#!/usr/bin/env python3
"""
End-to-end typing latency benchmark for voice-to-text output methods.

This measures the time from when text is sent via each method
until it actually appears in a GTK text buffer.

Methods tested:
1. dotool (type) - via dotoolc pipe to dotoold
2. mutter-virtual - via D-Bus TypeText (virtual keyboard)
3. mutter-commit - via D-Bus CommitText (Main.inputMethod.commit)

Requires:
- dotoold running (for method 1)
- GNOME Shell extension loaded with TypeText D-Bus service (for methods 2,3)
- GTK4 environment
"""

import asyncio
import os
import sys
import time
import statistics
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from voice_to_text.typer import DotoolTyper, DotoolcNotFoundError
from voice_to_text.mutter_virtual_typer import MutterVirtualTyper
from voice_to_text.mutter_virtual_paster import MutterVirtualPaster

# Test text - approximately 200 characters
TEST_TEXT = (
    "The quick brown fox jumps over the lazy dog. "
    "Pack my box with five dozen liquor jugs. "
    "How vexingly quick daft zebras jump! "
    "Bright vixens jump; dozy fowl quack. "
    "Sphinx of black quartz, judge my vow. "
    "Waltz, bad nymph, for quick jigs vex."
)

ITERATIONS = 10


class LatencyBenchmark:
    """Measures end-to-end typing latency by monitoring a GTK text buffer."""

    def __init__(self):
        self.text_view = None
        self.buffer = None
        self.results = {}
        self.current_method = None
        self.current_iteration = 0
        self.start_time = None
        self.text_received = False
        self.expected_text = ""
        self.received_chars = 0
        self.main_loop = None  # set in main()
        self.task = None  # benchmark async task

    def create_ui(self):
        """Create the test UI with a text view to receive typed text."""
        self.window = Gtk.Window()
        self.window.set_default_size(800, 400)
        self.window.set_title("Typing Latency Benchmark")
        self.window.connect("close-request", self.on_close)

        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        vbox.set_margin_top(12)
        vbox.set_margin_bottom(12)
        vbox.set_margin_start(12)
        vbox.set_margin_end(12)
        self.window.set_child(vbox)

        # Status label
        self.status_label = Gtk.Label()
        self.status_label.set_markup("<b>Starting benchmark...</b>")
        vbox.append(self.status_label)

        # Method label
        self.method_label = Gtk.Label()
        self.method_label.set_markup("Method: <i>waiting...</i>")
        vbox.append(self.method_label)

        # Progress label
        self.progress_label = Gtk.Label()
        self.progress_label.set_markup("Iteration: 0/0")
        vbox.append(self.progress_label)

        # Text view for receiving typed text
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_hexpand(True)
        scrolled.set_vexpand(True)
        vbox.append(scrolled)

        self.text_view = Gtk.TextView()
        self.text_view.set_editable(True)
        self.text_view.set_cursor_visible(True)
        self.text_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.buffer = self.text_view.get_buffer()
        scrolled.set_child(self.text_view)

        # Connect to buffer changes to detect when text appears
        self.buffer.connect("changed", self.on_buffer_changed)

        # Results text view
        results_scrolled = Gtk.ScrolledWindow()
        results_scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        results_scrolled.set_hexpand(True)
        results_scrolled.set_size_request(-1, 150)
        vbox.append(results_scrolled)

        self.results_buffer = Gtk.TextBuffer()
        self.results_view = Gtk.TextView()
        self.results_view.set_editable(False)
        self.results_view.set_cursor_visible(False)
        self.results_view.set_buffer(self.results_buffer)
        results_scrolled.set_child(self.results_view)

        # Close button
        close_btn = Gtk.Button(label="Close")
        close_btn.connect("clicked", lambda b: self.quit_app())
        close_btn.set_halign(Gtk.Align.END)
        vbox.append(close_btn)

        # Cancel button
        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.connect("clicked", lambda b: self.quit_app())
        cancel_btn.set_halign(Gtk.Align.END)
        vbox.append(cancel_btn)

        self.window.present()

    def on_close(self, window):
        self.quit_app()
        return True

    def quit_app(self):
        """Cancel benchmark (if running) and quit the GTK main loop."""
        if self.task is not None and not self.task.done():
            self.task.cancel()
        if self.main_loop is not None:
            self.main_loop.quit()

    def on_buffer_changed(self, buffer):
        """Called when text buffer changes - detect when expected text appears."""
        if not self.text_received and self.start_time is not None:
            current_text = buffer.get_text(
                buffer.get_start_iter(), buffer.get_end_iter(), False
            )
            if self.expected_text in current_text:
                elapsed = time.perf_counter() - self.start_time
                self.record_result(elapsed)

    def record_result(self, elapsed_ms):
        """Record a successful latency measurement."""
        self.text_received = True
        method_results = self.results.setdefault(self.current_method, [])
        method_results.append(elapsed_ms)

        char_count = len(self.expected_text)
        cps = char_count / elapsed_ms if elapsed_ms > 0 else 0

        # Update results display
        result_text = f"{self.current_method} run {self.current_iteration}: {elapsed_ms*1000:.2f} ms ({cps:.0f} chars/sec)\n"
        end_iter = self.results_buffer.get_end_iter()
        self.results_buffer.insert(end_iter, result_text)
        self.results_view.scroll_to_iter(end_iter, 0.0, False, 0.0, 0.0)

        print(f"  {self.current_method} run {self.current_iteration}: {elapsed_ms*1000:.2f} ms")

    def update_status(self, text):
        self.status_label.set_markup(text)

    def update_method(self, method, iteration, total):
        self.method_label.set_markup(f"Method: <b>{method}</b>")
        self.progress_label.set_markup(f"Iteration: {iteration}/{total}")

    async def run_benchmark(self):
        """Run benchmarks for all three methods."""
        self.create_ui()

        methods = [
            ("ydotool (type)", self.benchmark_ydotool),
            ("dotool (type)", self.benchmark_dotool),
            ("mutter-virtual (TypeText)", self.benchmark_mutter_virtual),
            ("mutter-commit (CommitText)", self.benchmark_mutter_commit),
        ]

        for method_name, benchmark_func in methods:
            self.current_method = method_name
            self.results[method_name] = []
            self.update_status(f"Testing <b>{method_name}</b>...")

            try:
                await benchmark_func()
            except Exception as e:
                print(f"  {method_name} failed: {e}")
                self.update_status(f"<b>{method_name}</b> failed: {e}")
                await asyncio.sleep(1)

        self.print_summary()
        self.update_status("<b>Benchmark complete!</b> Close window to exit.")

    async def benchmark_dotool(self):
        """Benchmark dotool typing."""
        typer = DotoolTyper()
        try:
            await typer.start()
            await asyncio.sleep(0.2)  # Let pipe stabilize

            for i in range(ITERATIONS):
                self.current_iteration = i + 1
                self.update_method(self.current_method, i + 1, ITERATIONS)

                # Clear buffer
                self.buffer.set_text("")
                self.text_received = False
                self.expected_text = TEST_TEXT

                # Small delay to ensure buffer is cleared
                await asyncio.sleep(0.05)

                self.start_time = time.perf_counter()
                await typer.stream_type(TEST_TEXT)

                # Wait for text to appear (with timeout)
                await self.wait_for_text(timeout=5.0)

                await asyncio.sleep(0.2)  # Delay between iterations

            await typer.stop()

        except DotoolcNotFoundError as e:
            raise RuntimeError(f"dotool not available: {e}")
        except Exception as e:
            raise RuntimeError(f"dotool benchmark failed: {e}")

    async def benchmark_ydotool(self):
        """Benchmark ydotool typing (uinput-based, like dotool)."""
        import shutil

        ydotool_path = shutil.which("ydotool")
        if not ydotool_path:
            raise RuntimeError("ydotool not found in PATH")

        for i in range(ITERATIONS):
            self.current_iteration = i + 1
            self.update_method(self.current_method, i + 1, ITERATIONS)

            self.buffer.set_text("")
            self.text_received = False
            self.expected_text = TEST_TEXT

            await asyncio.sleep(0.05)

            self.start_time = time.perf_counter()
            # Pass text directly as arg (most reliable; -d 0 = zero key-delay)
            proc = await asyncio.create_subprocess_exec(
                ydotool_path, "type", "-d", "0", TEST_TEXT,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()

            await self.wait_for_text(timeout=5.0)
            await asyncio.sleep(0.2)

    async def benchmark_mutter_virtual(self):
        """Benchmark mutter-virtual typing."""
        typer = MutterVirtualTyper()
        try:
            await typer.start()
            if not typer.is_running:
                raise RuntimeError("D-Bus service not available")

            for i in range(ITERATIONS):
                self.current_iteration = i + 1
                self.update_method(self.current_method, i + 1, ITERATIONS)

                self.buffer.set_text("")
                self.text_received = False
                self.expected_text = TEST_TEXT
                typer._typed_text = ""

                await asyncio.sleep(0.05)

                self.start_time = time.perf_counter()
                await typer.stream_diff(TEST_TEXT)

                await self.wait_for_text(timeout=5.0)
                await asyncio.sleep(0.2)

        except Exception as e:
            raise RuntimeError(f"mutter-virtual benchmark failed: {e}")
        finally:
            await typer.stop()

    async def benchmark_mutter_commit(self):
        """Benchmark mutter-commit typing."""
        paster = MutterVirtualPaster()
        try:
            await paster.start()
            if not paster.is_running:
                raise RuntimeError("D-Bus service not available")

            for i in range(ITERATIONS):
                self.current_iteration = i + 1
                self.update_method(self.current_method, i + 1, ITERATIONS)

                self.buffer.set_text("")
                self.text_received = False
                self.expected_text = TEST_TEXT
                paster._typed_text = ""

                await asyncio.sleep(0.05)

                self.start_time = time.perf_counter()
                await paster.stream_diff(TEST_TEXT)
                await paster.flush()

                await self.wait_for_text(timeout=5.0)
                await asyncio.sleep(0.2)

        except Exception as e:
            raise RuntimeError(f"mutter-commit benchmark failed: {e}")
        finally:
            await paster.stop()

    async def wait_for_text(self, timeout=5.0):
        """Wait for text to appear in buffer."""
        start = time.perf_counter()
        while not self.text_received:
            if time.perf_counter() - start > timeout:
                print(f"  Timeout waiting for text")
                # Record timeout as failed
                method_results = self.results.setdefault(self.current_method, [])
                method_results.append(None)  # Mark as timeout
                break
            await asyncio.sleep(0.01)

    def print_summary(self):
        """Print benchmark summary."""
        print("\n" + "=" * 70)
        print("BENCHMARK SUMMARY")
        print("=" * 70)
        char_count = len(TEST_TEXT)

        for method_name, times in self.results.items():
            # Filter out None (timeouts)
            valid_times = [t for t in times if t is not None]
            timeouts = len(times) - len(valid_times)

            if not valid_times:
                print(f"\n{method_name}: All {timeouts} runs timed out")
                continue

            print(f"\n{method_name} ({char_count} chars x {len(valid_times)} runs):")
            for i, t in enumerate(valid_times, 1):
                cps = char_count / t if t > 0 else 0
                print(f"  Run {i}: {t*1000:.2f} ms  ({cps:.0f} chars/sec)")

            avg = statistics.mean(valid_times)
            stdev = statistics.stdev(valid_times) if len(valid_times) > 1 else 0
            min_t = min(valid_times)
            max_t = max(valid_times)
            avg_cps = char_count / avg

            print(f"  Average: {avg*1000:.2f} ms  ({avg_cps:.0f} chars/sec)")
            print(f"  Min:     {min_t*1000:.2f} ms")
            print(f"  Max:     {max_t*1000:.2f} ms")
            if stdev:
                print(f"  Stdev:   {stdev*1000:.2f} ms")
            if timeouts:
                print(f"  Timeouts: {timeouts}")

        # Comparison
        print("\n" + "=" * 70)
        print("COMPARISON (average end-to-end latency)")
        print("=" * 70)

        valid_results = []
        for method_name, times in self.results.items():
            valid_times = [t for t in times if t is not None]
            if valid_times:
                valid_results.append((method_name, statistics.mean(valid_times)))

        if valid_results:
            valid_results.sort(key=lambda x: x[1])
            for name, avg_time in valid_results:
                cps = char_count / avg_time
                print(f"  {name:30s}: {avg_time*1000:>7.2f} ms  ({cps:>7.0f} chars/sec)")


async def main():
    # Initialize GTK
    Gtk.init()

    benchmark = LatencyBenchmark()

    # Run benchmark in the GTK main loop
    loop = asyncio.get_event_loop()
    benchmark.task = loop.create_task(benchmark.run_benchmark())

    # Run GTK main loop
    main_loop = GLib.MainLoop()
    benchmark.main_loop = main_loop
    await loop.run_in_executor(None, main_loop.run)


if __name__ == "__main__":
    asyncio.run(main())