using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    internal const int HostLayoutReportId = 5;

    private static async Task Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine("Bluke Bluetooth Language Bridge 1.2.2 - press Ctrl+C to exit.");
        Console.WriteLine("Uses the existing Bluetooth HID connection; no Wi-Fi or hotspot is used.");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

        HidOutputDevice? device = null;
        string? lastLayout = null;
        long lastHkl = long.MinValue;
        var lastSent = DateTime.MinValue;
        var nextDiscovery = DateTime.MinValue;

        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (device is null && DateTime.UtcNow >= nextDiscovery)
                {
                    device = HidOutputDevice.FindBluke();
                    nextDiscovery = DateTime.UtcNow.AddSeconds(2);
                    if (device is not null)
                    {
                        Console.WriteLine("Bluke Bluetooth HID channel found.");
                        lastLayout = null;
                        lastHkl = long.MinValue;
                    }
                    else
                    {
                        Console.WriteLine("Waiting for the paired Bluke phone over Bluetooth...");
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

    public static HidOutputDevice? FindBluke()
    {
        HidD_GetHidGuid(out var hidGuid);
        var infoSet = SetupDiGetClassDevs(ref hidGuid, null, IntPtr.Zero,
            DigcfPresent | DigcfDeviceInterface);
        if (infoSet == new IntPtr(-1)) return null;

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

                    var candidate = CreateFile(path, GenericRead | GenericWrite,
                        FileShareRead | FileShareWrite, IntPtr.Zero,
                        OpenExisting, FileAttributeNormal, IntPtr.Zero);
                    if (candidate.IsInvalid)
                    {
                        candidate.Dispose();
                        continue;
                    }

                    if (HidD_GetPreparsedData(candidate, out var preparsed))
                    {
                        try
                        {
                            var status = HidP_GetCaps(preparsed, out var caps);
                            if (status == HidpStatusSuccess &&
                                caps.UsagePage == VendorUsagePage &&
                                caps.Usage == VendorUsage &&
                                caps.OutputReportByteLength >= 2)
                            {
                                return new HidOutputDevice(candidate, caps.OutputReportByteLength);
                            }
                        }
                        finally
                        {
                            HidD_FreePreparsedData(preparsed);
                        }
                    }

                    candidate.Dispose();
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

        return null;
    }

    public bool TrySendLayout(byte layoutCode, out string error)
    {
        var report = new byte[outputReportLength];
        report[0] = (byte)Program.HostLayoutReportId;
        report[1] = layoutCode;

        if (HidD_SetOutputReport(handle, report, report.Length))
        {
            error = "";
            return true;
        }

        if (WriteFile(handle, report, report.Length, out var written, IntPtr.Zero) &&
            written == report.Length)
        {
            error = "";
            return true;
        }

        error = $"HID output report rejected (Win32 {Marshal.GetLastWin32Error()})";
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