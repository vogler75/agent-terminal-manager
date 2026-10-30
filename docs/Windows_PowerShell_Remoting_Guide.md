# Windows PowerShell Remoting: Windows 11 to Windows 10 Guide

This instruction document outlines the complete procedure for enabling and configuring PowerShell Remoting between a **Windows 11 client** and a **Windows 10 target machine** in a workgroup environment.

---

## Prerequisites & Overview

* **Source (Client):** Windows 11 PC  
* **Target (Server):** Windows 10 PC  
* **Environment:** Local network / Workgroup (Non-Domain)  
* **Required Access:** Administrator privileges on both machines.

---

## Phase 1: Configure the Target Machine (Windows 10\)

Before your Windows 11 PC can connect, the Windows 10 machine must be configured to accept incoming remote management connections.

### Step 1.1: Open PowerShell as Administrator

1. Press the **Windows Key**.  
2. Type `powershell`.  
3. Right-click **Windows PowerShell** and select **Run as administrator**.

### Step 1.2: Enable PowerShell Remoting

Run the following cmdlet to configure WinRM, start the service, set it to automatic startup, and open the necessary firewall rules:

```
Enable-PSRemoting -Force
```

### Step 1.3: Verify the Network Profile

WinRM blocks remote management if the network connection is classified as "Public". Ensure your network profile is set to **Private**.

1. Check your network category:

```
Get-NetConnectionProfile
```

2. If the network category is listed as `Public`, change it to `Private` (replace `InterfaceIndex` with your actual network interface index, e.g., `1`):

```
Set-NetConnectionProfile -InterfaceIndex 1 -NetworkCategory Private
```

---

## Phase 2: Configure the Client Machine (Windows 11\)

Because the machines are in a workgroup rather than an Active Directory domain, you must configure the Windows 11 client to trust the Windows 10 target.

### Step 2.1: Open PowerShell as Administrator

1. Press the **Windows Key** on your Windows 11 PC.  
2. Type `powershell`.  
3. Right-click **Windows PowerShell** and select **Run as administrator**.

### Step 2.2: Add the Target PC to TrustedHosts

Run the following command to trust your Windows 10 machine (replace `YOUR_WINDOWS_10_IP_OR_HOSTNAME` with the actual IP address or computer name, e.g., `192.168.1.50`):

```
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "YOUR_WINDOWS_10_IP_OR_HOSTNAME"
```

> **Tip for Multiple Hosts:** If you need to add subsequent machines later without overwriting your current list, use the `-Concatenate` parameter:

```
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "ANOTHER_IP_OR_NAME" -Concatenate
```

### Step 2.3: Verify TrustedHosts Configuration

Confirm that the target machine has been successfully added to the client's trust list:

```
Get-Item WSMan:\localhost\Client\TrustedHosts
```

---

## Phase 3: Connect and Test the Remote Session

Once configuration is complete, initiate an interactive remote session from your Windows 11 PC to your Windows 10 PC.

### Step 3.1: Establish the Session

Run the following command:

```
Enter-PSSession -ComputerName "YOUR_WINDOWS_10_IP_OR_HOSTNAME" -Credential (Get-Credential)
```

### Step 3.2: Enter Credentials

1. A authentication dialog box will appear.  
2. Enter a valid **Administrator username and password** belonging to the **Windows 10** target machine.  
3. Upon successful authentication, your command prompt prefix will update to reflect that you are executing commands on the remote Windows 10 system.

### Step 3.3: Exiting the Session

When you are finished working on the remote machine, close the session and return to your local prompt by typing:

```
Exit-PSSession
```

---

## Maintenance & Troubleshooting

* **Clearing TrustedHosts:** If you ever wish to reset or clear your TrustedHosts list back to default, run:

```
Set-Item WSMan:\localhost\Client\TrustedHosts -Value ""
```

* **Firewall/Connectivity Issues:** Ensure that TCP ports `5985` (HTTP) and `5986` (HTTPS) are not blocked by third-party antivirus software or firewalls on the local network.