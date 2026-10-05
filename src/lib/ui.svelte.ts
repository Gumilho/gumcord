// What fills the main pane. Chat, servers and voice all change it, so it belongs to none of them.

class Ui {
  // The selected text channel, or the call view of the connected voice channel.
  mainView: "chat" | "call" = $state("chat");
  // The call filling the window, without the server list, channels, header or member list. Just for this call.
  callExpanded = $state(false);
}

export const ui = new Ui();
