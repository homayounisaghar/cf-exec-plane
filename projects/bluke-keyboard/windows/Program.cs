using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    internal const int HostLayoutReportId = 5;

    private static async Task Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("Bluke Bluetooth Language Bridge 1.2.3 - press Ctrl+C to exit.");
        Console.WriteLine("Uses the existing Bluetooth HID connection; no Wi-Fi or hotspot is used.");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

        HidOutputDevice? device = null;
        string? lastLayout = null;
        long lastHkl = long.MinValue;
        var lastSent = DateTime.MinValue;
        var nextDiscovery = DateTime.MinValue;
        var lastDiagnostic = DateTime.MinValue;
        string? lastScan = null;

        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (device is null && DateTime.UtcNow >= nextDiscovery)
                {
                    device = HidOutputDevice.FindBluke(out var scan);
                    nextDiscovery = DateTime.UtcNow.AddSeconds(2);
                    if (device is not null)
                    {
                        Console.WriteLine("Bluke Bluetooth HID output collection found.");
                        lastLayout = null;
                        lastHkl = long.MinValue;
                    }
                    else if (scan != lastScan || DateTime.UtcNow - lastDiagnostic > TimeSpan.FromSeconds(10))
                    {
                        Console.WriteLine(scan);
                        lastScan = scan;
                        lastDiagnostic = DateTime.UtcNow;
                    }
                }

                if (device is not null)
                {
                    var input = ForegroundInputLayout.Read();
                    var (layout, code) = Map(input.LanguageId);
                    if (layout != lastLayout || input.Hkl != lastHkl ||
                        DateTime.UtcNow - lastSent > TimeSpan.FromSeconds(5))
                    {
                        if (device.TrySendLayout(code, out var error))
                        {
                            lastLayout = layout;
                            lastHkl = input.Hkl;
                            lastSent = DateTime.UtcNow;
                            Console.WriteLine($"{input.LanguageId:X4} -> {layout} (Bluetooth HID)");
                        }
                        else
                        {
                            Console.WriteLine($"Bluetooth HID send failed: {error}. Reconnecting...");
                            device.Dispose();
                            device = null;
                            nextDiscovery = DateTime.MinValue;
                        }
                    }
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Console.WriteLine($"Bridge retry: {ex.Message}");
                device?.Dispose();
                device = null;
                nextDiscovery = DateTime.MinValue;
            }

            try { await Task.Delay(250, stop.Token); }
            catch (OperationCanceledException) { break; }
        }

        device?.Dispose();
    }

    private static (string Name, byte Code) Map(ushort languageId)
    {
        return (languageId & 0x03FF) switch
        {
            0x0029 or 0x008C => ("Persian", 4),
            0x0007 => ("German", 2),
            0x000C => ("French", 1),
            0x0019 => ("Russian", 3),
            _ => ("English (US)", 0)
        };
    }
}

internal sealed class HidOutputDevice : IDisposable
{
    private const ushort VendorUsagePage = 0xFF00;
    private const ushort VendorUsage = 0x0001;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint DigcfPresent = 0x00000002;
    private const uint DigcfDeviceInterface = 0x00000010;
    private const int ErrorNoMoreItems = 259;
    private const int HidpStatusSuccess = 0x00110000;

    private readonly SafeFileHandle handle;
    private readonly int outputReportLength;

    private HidOutputDevice(SafeFileHandle handle, int outputReportLength)
    {
        this.handle = handle;
        this.outputReportLength = outputReportLength;
    }

    public static HidOutputDevice? FindBluke(out string diagnostics)
    {
        var notes = new List<string>();
        var seen = 0;
        var relevant = 0;
        HidD_GetHidGuid(out var hidGuid);
        var infoSet = SetupDiGetClassDevs(ref hidGuid, null, IntPtr.Zero,
            DigcfPresent | DigcfDeviceInterface);
        if (infoSet == new IntPtr(-1))
        {
            diagnostics = $"HID enumeration failed: SetupDiGetClassDevs Win32={Marshal.GetLastWin32Error()}";
            return null;
        }

        try
        {
            for (uint index = 0; index < 512; index++)
            {
                var interfaceData = new DeviceInterfaceData
                {
                    Size = Marshal.SizeOf<DeviceInterfaceData>()
                };
                if (!SetupDiEnumDeviceInterfaces(infoSet, IntPtr.Zero, ref hidGuid, index, ref interfaceData))
                {
                    if (Marshal.GetLastWin32Error() == ErrorNoMoreItems) break;
                    continue;
                }

                seen++;
                _ = SetupDiGetDeviceInterfaceDetail(infoSet, ref interfaceData,
                    IntPtr.Zero, 0, out var requiredSize, IntPtr.Zero);
                if (requiredSize == 0) continue;

                var detail = Marshal.AllocHGlobal((int)requiredSize);
                try
                {
                    Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetail(infoSet, ref interfaceData,
                            detail, requiredSize, out _, IntPtr.Zero))
                        continue;

                    var path = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
                    if (string.IsNullOrWhiteSpace(path)) continue;

                    using var inspect = OpenForInspection(path);
                    if (inspect is null)
                    {
                        if (path.Contains("BTH", StringComparison.OrdinalIgnoreCase))
                            notes.Add($"HID[{index}] Bluetooth path could not be opened (Win32={Marshal.GetLastWin32Error()}).");
                        continue;
                    }

                    var product = ReadHidString(inspect, HidD_GetProductString);
                    var manufacturer = ReadHidString(inspect, HidD_GetManufacturerString);
                    var attributes = new HidAttributes { Size = Marshal.SizeOf<HidAttributes>() };
                    var hasAttributes = HidD_GetAttributes(inspect, ref attributes);

                    if (!HidD_GetPreparsedData(inspect, out var preparsed))
                    {
                        if (IsRelevant(product, path))
                            notes.Add($"HID[{index}] product='{product}' preparsed-data failed Win32={Marshal.GetLastWin32Error()} path={ShortPath(path)}");
                        continue;
                    }

                    try
                    {
                        var status = HidP_GetCaps(preparsed, out var caps);
                        if (status != HidpStatusSuccess)
                        {
                            if (IsRelevant(product, path))
                                notes.Add($"HID[{index}] product='{product}' HidP_GetCaps=0x{unchecked((uint)status):X8} path={ShortPath(path)}");
                            continue;
                        }

                        var isVendorCollection = caps.UsagePage == VendorUsagePage &&
                                                 caps.Usage == VendorUsage &&
                                                 caps.OutputReportByteLength >= 2;
                        var isBlukeVendorCollection = isVendorCollection &&
                            (product.Contains("Bluke", StringComparison.OrdinalIgnoreCase) ||
                             path.Contains("BTH", StringComparison.OrdinalIgnoreCase));
                        var isKeyboardCollection = caps.UsagePage == 0x0001 && caps.Usage == 0x0006;
                        if (isBlukeVendorCollection || IsRelevant(product, path) || isKeyboardCollection)
                        {
                            relevant++;
                            var ids = hasAttributes
                                ? $" vid:pid={attributes.VendorID:X4}:{attributes.ProductID:X4}"
                                : "";
                            notes.Add($"HID[{index}] page=0x{caps.UsagePage:X4} usage=0x{caps.Usage:X4} in={caps.InputReportByteLength} out={caps.OutputReportByteLength} product='{product}' manufacturer='{manufacturer}'{ids} path={ShortPath(path)}");
                        }

                        if (isBlukeVendorCollection)
                        {
                            var writable = OpenForWrite(path);
                            if (writable is not null)
                            {
                                diagnostics = $"HID scan: {seen} interfaces; Bluke output collection found.\n" +
                                              string.Join("\n", notes);
                                return new HidOutputDevice(writable, caps.OutputReportByteLength);
                            }

                            notes.Add($"HID[{index}] Bluke output collection matched, but write-open failed Win32={Marshal.GetLastWin32Error()}.");
                        }
                    }
                    finally
                    {
                        HidD_FreePreparsedData(preparsed);
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(detail);
                }
            }
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(infoSet);
        }

        diagnostics = $"HID scan: {seen} interfaces enumerated; {relevant} relevant collections shown; " +
                      "no Bluke vendor output collection (usage page FF00, usage 0001, output length >= 2) was found.";
        if (notes.Count > 0) diagnostics += "\n" + string.Join("\n", notes.Take(30));
        else diagnostics += "\nWindows returned no Bluke, Bluetooth, keyboard, or vendor-defined HID collection details.";
        return null;
    }

    private static SafeFileHandle? OpenForInspection(string path)
    {
        var handle = CreateFile(path, GenericRead | GenericWrite, FileShareRead | FileShareWrite,
            IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();

        handle = CreateFile(path, GenericWrite, FileShareRead | FileShareWrite,
            IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();

        handle = CreateFile(path, GenericRead, FileShareRead | FileShareWrite,
            IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();

        handle = CreateFile(path, 0, FileShareRead | FileShareWrite, IntPtr.Zero,
            OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        return null;
    }

    private static SafeFileHandle? OpenForWrite(string path)
    {
        var handle = CreateFile(path, GenericWrite, FileShareRead | FileShareWrite, IntPtr.Zero,
            OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();

        handle = CreateFile(path, GenericRead | GenericWrite, FileShareRead | FileShareWrite,
            IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        return null;
    }

    private static bool IsRelevant(string product, string path) =>
        product.Contains("Bluke", StringComparison.OrdinalIgnoreCase) ||
        path.Contains("BTH", StringComparison.OrdinalIgnoreCase) ||
        path.Contains("FF00", StringComparison.OrdinalIgnoreCase);

    private static string ShortPath(string path) =>
        path.Length <= 100 ? path : "..." + path[^97..];

    private delegate bool HidStringGetter(SafeFileHandle handle, StringBuilder buffer, int bufferLength);

    private static string ReadHidString(SafeFileHandle handle, HidStringGetter getter)
    {
        var buffer = new StringBuilder(256);
        return getter(handle, buffer, buffer.Capacity * 2) ? buffer.ToString().Trim() : "";
    }

    public bool TrySendLayout(byte layoutCode, out string error)
    {
        var report = new byte[outputReportLength];
        report[0] = (byte)Program.HostLayoutReportId;
        report[1] = layoutCode;

        if (WriteFile(handle, report, report.Length, out var written, IntPtr.Zero) &&
            written == report.Length)
        {
            error = "";
            return true;
        }

        var writeError = Marshal.GetLastWin32Error();
        if (HidD_SetOutputReport(handle, report, report.Length))
        {
            error = "";
            return true;
        }

        error = $"HID report ID 5 rejected (WriteFile Win32 {writeError}; HidD_SetOutputReport Win32 {Marshal.GetLastWin32Error()})";
        return false;
    }

    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInterfaceData
    {
        public int Size;
        public Guid InterfaceClassGuid;
        public int Flags;
        public IntPtr Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HidAttributes
    {
        public int Size;
        public ushort VendorID;
        public ushort ProductID;
        public ushort VersionNumber;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HidpCaps
    {
        public ushort Usage;
        public ushort UsagePage;
        public ushort InputReportByteLength;
        public ushort OutputReportByteLength;
        public ushort FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)]
        public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes;
        public ushort NumberInputButtonCaps;
        public ushort NumberInputValueCaps;
        public ushort NumberInputDataIndices;
        public ushort NumberOutputButtonCaps;
        public ushort NumberOutputValueCaps;
        public ushort NumberOutputDataIndices;
        public ushort NumberFeatureButtonCaps;
        public ushort NumberFeatureValueCaps;
        public ushort NumberFeatureDataIndices;
    }

    [DllImport("hid.dll")]
    private static extern void HidD_GetHidGuid(out Guid hidGuid);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_GetPreparsedData(SafeFileHandle device, out IntPtr preparsedData);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_FreePreparsedData(IntPtr preparsedData);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_GetProductString(SafeFileHandle device, StringBuilder buffer, int bufferLength);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_GetManufacturerString(SafeFileHandle device, StringBuilder buffer, int bufferLength);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_GetAttributes(SafeFileHandle device, ref HidAttributes attributes);

    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_SetOutputReport(SafeFileHandle device, byte[] report, int reportLength);

    [DllImport("hid.dll")]
    private static extern int HidP_GetCaps(IntPtr preparsedData, out HidpCaps capabilities);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string? enumerator,
        IntPtr parent, uint flags);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiEnumDeviceInterfaces(IntPtr deviceInfoSet, IntPtr deviceInfoData,
        ref Guid interfaceClassGuid, uint memberIndex, ref DeviceInterfaceData interfaceData);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, EntryPoint = "SetupDiGetDeviceInterfaceDetailW",
        ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr deviceInfoSet,
        ref DeviceInterfaceData interfaceData, IntPtr detailData, uint detailDataSize,
        out uint requiredSize, IntPtr deviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess,
        uint shareMode, IntPtr securityAttributes, uint creationDisposition,
        uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(SafeFileHandle file, byte[] buffer, int bytesToWrite,
        out int bytesWritten, IntPtr overlapped);
}

[executed on device: ubuntu-16gb-hel1-2 (a1c21909-360a-4044-b63e-263af0ebd786)]