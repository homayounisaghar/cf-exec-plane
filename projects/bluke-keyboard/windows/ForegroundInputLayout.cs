using System.Runtime.InteropServices;

internal static class ForegroundInputLayout
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetKeyboardLayout(uint threadId);

    public static ushort ReadLanguageId()
    {
        var window = GetForegroundWindow();
        var threadId = window == IntPtr.Zero ? 0 : GetWindowThreadProcessId(window, out _);
        var layout = GetKeyboardLayout(threadId);
        return (ushort)(layout.ToInt64() & 0xFFFF);
    }
}
