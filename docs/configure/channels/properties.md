# Properties

Choose a channel a name. Optionally, you can also add a thumbnail by uploading an image or providing an image URL. This will be the logo visible within your IPTV client's channel guide. Transparent .png files are supported. 

## Channel Icon

The channel icon has three states:

- **Custom icon** -- Upload an image or provide a URL. This image appears in your IPTV client's channel guide, watermark overlays, and the Tunarr UI.
- **Default logo** -- When no custom icon is set, Tunarr shows its default logo as a fallback. This is the default behavior.
- **No icon** -- Click the **X** button next to the icon preview to remove the icon entirely. In this state, no icon is included in the M3U playlist, XMLTV guide data, or watermark overlay. To restore the default logo after removing the icon, click the **restore** button.

On-Demand will allow your channels to behave similar to streaming services, where the watch states will only progress while you're actively viewing the channel. This is disabled by default, which means by default channels will behave similar to traditional televison where watch states will progress without you actively viewing the channel.

![Channel properties](/assets/channel-properties.png)

Click the ["FLEX" tab](/configure/channels/flex) if you'd like to configure optional filler content to play in-between episodes.

## Auto-skip credits

Auto-skip credits is off by default. Enable it in a channel's Properties to omit explicit outro marker intervals from movies and episodes. Unmarked scenes between credit sections and after the last section still play, in their original order. The next program starts after the retained content finishes. Media files are never changed.

Schedules and guide entries use the retained playback duration. Saving a changed setting regenerates an existing slot schedule; manual lineups keep their program order. Disabling the setting restores the original source spans.

Plex credit markers already imported into Tunarr are supported. The final-marker flag is retained when supplied, but never extends a skip beyond the marker's explicit end. Missing, invalid, out-of-range or whole-file markers leave playback unchanged. Programs with multiple media versions or a duration mismatch also play unchanged. Ordinary chapter titles are not credit markers. This setting does not scan libraries or analyze media, and filler clips retain their existing behavior.
