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
        var manualHost = ReadHost(args);
        Console.WriteLine("Bluke Language Bridge 1.2.1 - press Ctrl+C to exit.");
        Console.WriteLine("Only the active keyboard layout is sent; typed text stays on Bluetooth HID.");

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; stop.Cancel(); };

        while (!stop.IsCancellationRequested)
        {
            var target = manualHost is null
                ? FindPhoneGateway()
                : new GatewayTarget(manualHost, "manual --host");

            if (target is null)
            {
                Console.WriteLine("No Wi-Fi hotspot gateway found. Connect this PC to the phone hotspot.");
                await Pause(stop.Token);
                continue;
            }

            try
            {
                Console.WriteLine($"Connecting to phone at {target.Address}:{Port} via {target.InterfaceName}...");
                using var client = new TcpClient { NoDelay = true };
                await client.ConnectAsync(target.Address, Port, stop.Token);
                Console.WriteLine($"Connected to phone at {target.Address}:{Port}.");

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
                        var json = JsonSerializer.Serialize(new
                        {
                            protocol = Protocol,
                            langId = input.LanguageId.ToString("X4"),
                            hkl = $"0x{input.Hkl:X}",
                            layout
                        });
                        await writer.WriteLineAsync(json);
                        var acknowledgement = await reader.ReadLineAsync(stop.Token);
                        if (acknowledgement is null)
                            throw new IOException("Phone closed the language bridge connection.");

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
                Console.WriteLine($"Connection to {target.Address}:{Port} failed: {ex.Message}");
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
            if (args[i] == "--host" && IPAddress.TryParse(args[i + 1], out var host))
                return host;
        }
        return null;
    }

    private static GatewayTarget? FindPhoneGateway()
    {
        var candidates = NetworkInterface.GetAllNetworkInterfaces()
            .Where(network => network.OperationalStatus == OperationalStatus.Up)
            .Where(network => !LooksLikeVpn(network))
            .SelectMany(network => network.GetIPProperties().GatewayAddresses
                .Select(gateway => gateway.Address)
                .Where(IsPrivateLanAddress)
                .Select(address => new GatewayTarget(address, network.Name)))
            .OrderBy(target => target.InterfaceName.Contains("wi-fi", StringComparison.OrdinalIgnoreCase) ||
                               target.InterfaceName.Contains("wlan", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(target => target.InterfaceName, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();

        return candidates;
    }

    private static bool LooksLikeVpn(NetworkInterface network)
    {
        var identity = (network.Name + " " + network.Description).ToLowerInvariant();
        return new[] { "vpn", "wireguard", "wintun", "tap-", "tunnel", "proton", "firefox", "openvpn", "tailscale", "zerotier" }
            .Any(identity.Contains);
    }

    private static bool IsPrivateLanAddress(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 ||
               (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
               (bytes[0] == 192 && bytes[1] == 168) ||
               (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127);
    }

    private static async Task Pause(CancellationToken token)
    {
        try { await Task.Delay(2000, token); } catch (OperationCanceledException) { }
    }

    private sealed record GatewayTarget(IPAddress Address, string InterfaceName);
}
