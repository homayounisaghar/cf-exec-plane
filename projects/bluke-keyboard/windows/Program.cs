using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int Port = 39472;
    private const string Protocol = "bluke-language-v1";

    private static async Task Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var host = ReadHost(args);
        Console.WriteLine("Bluke Language Bridge - press Ctrl+C to exit.");
        Console.WriteLine("Only the active keyboard layout is sent; typed text stays on Bluetooth HID.");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

        while (!stop.IsCancellationRequested)
        {
            var gateway = host ?? FindGateway();
            if (gateway is null)
            {
                Console.WriteLine("Waiting for phone hotspot...");
                await Pause(stop.Token);
                continue;
            }

            try
            {
                using var client = new TcpClient { NoDelay = true };
                await client.ConnectAsync(gateway, Port, stop.Token);
                Console.WriteLine($"Connected to {gateway}:{Port}");

                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, new UTF8Encoding(false), false, 1024, true);
                using var writer = new StreamWriter(stream, new UTF8Encoding(false), 1024, true) { AutoFlush = true };

                string? lastLayout = null;
                long lastHkl = long.MinValue;
                var lastSent = DateTime.MinValue;

                while (client.Connected && !stop.IsCancellationRequested)
                {
                    var input = ForegroundInputLayout.Read();
                    var layout = Map(input.LanguageId);
                    if (layout != lastLayout || input.Hkl != lastHkl ||
                        DateTime.UtcNow - lastSent > TimeSpan.FromSeconds(5))
                    {
                        var json = JsonSerializer.Serialize(new {
                            protocol = Protocol,
                            langId = input.LanguageId.ToString("X4"),
                            hkl = $"0x{input.Hkl:X}",
                            layout
                        });
                        await writer.WriteLineAsync(json);
                        var ack = await reader.ReadLineAsync(stop.Token);
                        if (ack is null) throw new IOException("Phone closed the connection.");
                        lastLayout = layout;
                        lastHkl = input.Hkl;
                        lastSent = DateTime.UtcNow;
                        Console.WriteLine($"{input.LanguageId:X4} -> {layout}");
                    }
                    await Task.Delay(250, stop.Token);
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Console.WriteLine($"Retrying: {ex.Message}");
                await Pause(stop.Token);
            }
        }
    }

    private static string Map(ushort lang)
    {
        return (lang & 0x03FF) switch
        {
            0x0029 or 0x008C => "fa_persian_standard",
            0x0007 => "de_qwertz",
            0x000C => "fr_azerty",
            0x0019 => "ru_jcuken",
            _ => "us_qwerty"
        };
    }

    private static IPAddress? ReadHost(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--host")
                return IPAddress.Parse(args[i + 1]);
        }
        return null;
    }

    private static IPAddress? FindGateway()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up)
            .OrderBy(n => n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 0 : 1)
            .SelectMany(n => n.GetIPProperties().GatewayAddresses)
            .Select(g => g.Address)
            .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a));
    }

    private static async Task Pause(CancellationToken token)
    {
        try { await Task.Delay(1500, token); } catch (OperationCanceledException) { }
    }
}
