import { useEffect, useMemo, useRef, useState } from "react";
import { api, clearSession, getStoredUser, setSession, updateStoredUser } from "./api";
import {
  clearStoredChatSecret,
  decryptMessage,
  encryptMessage,
  getStoredChatSecret,
  setStoredChatSecret
} from "./crypto";
import { enablePushNotifications, isPushSupported } from "./push";
import { connectSocket, disconnectSocket } from "./socket";

const AVATAR_COLORS = ["#3466f6", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2"];
const EMOJIS = ["😀", "😂", "😍", "😎", "🥳", "😅", "😮", "😢", "😡", "👍", "🙏", "🔥", "❤️", "💯", "🎉", "👀"];

function displayName(person = {}) {
  return person.display_name || person.username || "";
}

function initials(name = "") {
  return name.slice(0, 2).toUpperCase();
}

function formatMessageTime(value) {
  return new Date(value).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
}

function generateSecret() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("-");
}

function parseMessageContent(content) {
  if (!content?.startsWith("{")) return { type: "text", text: content || "" };

  try {
    const payload = JSON.parse(content);
    if (payload.type === "image") return payload;
  } catch {
    return { type: "text", text: content };
  }

  return { type: "text", text: content };
}

async function imageFileToDataUrl(file) {
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });

  const canvas = document.createElement("canvas");
  const maxSize = 1200;
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(image.src);

  return canvas.toDataURL("image/jpeg", 0.74);
}

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const [mode, setMode] = useState("login");
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [socket, setSocket] = useState(null);
  const [users, setUsers] = useState([]);
  const [onlineUserIds, setOnlineUserIds] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [decryptedMessages, setDecryptedMessages] = useState([]);
  const [messageText, setMessageText] = useState("");
  const [chatSecret, setChatSecret] = useState(getStoredChatSecret());
  const [secretDraft, setSecretDraft] = useState(getStoredChatSecret());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("profile");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState("");
  const [profileForm, setProfileForm] = useState({
    displayName: user?.display_name || "",
    avatarColor: user?.avatar_color || AVATAR_COLORS[0]
  });
  const [chatError, setChatError] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const selectedUserIsOnline = useMemo(() => {
    if (!selectedUser) return false;
    return onlineUserIds.includes(selectedUser.id);
  }, [onlineUserIds, selectedUser]);

  useEffect(() => {
    if (!user) return undefined;

    loadUsers();

    const activeSocket = connectSocket();
    setSocket(activeSocket);

    if (!activeSocket) return undefined;

    activeSocket.on("users:online", (ids) => setOnlineUserIds(ids));
    activeSocket.on("users:changed", loadUsers);
    activeSocket.on("profile:updated", (updatedUser) => {
      updateStoredUser(updatedUser);
      setUser(updatedUser);
      setProfileForm({
        displayName: updatedUser.display_name || "",
        avatarColor: updatedUser.avatar_color || AVATAR_COLORS[0]
      });
    });
    activeSocket.on("message:new", (message) => {
      setMessages((current) => {
        const alreadyExists = current.some((item) => item.id === message.id);
        if (alreadyExists) return current;

        const belongsToSelectedChat =
          selectedUser &&
          (message.sender_id === selectedUser.id || message.receiver_id === selectedUser.id);

        return belongsToSelectedChat ? [...current, message] : current;
      });
    });

    return () => {
      activeSocket.off("users:online");
      activeSocket.off("users:changed", loadUsers);
      activeSocket.off("profile:updated");
      activeSocket.off("message:new");
      disconnectSocket();
    };
  }, [user, selectedUser]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [decryptedMessages]);

  useEffect(() => {
    let cancelled = false;

    async function decryptVisibleMessages() {
      if (!selectedUser || !user) {
        setDecryptedMessages([]);
        return;
      }

      const items = await Promise.all(
        messages.map(async (message) => {
          try {
            const content = chatSecret
              ? await decryptMessage(message.content, chatSecret, user.id, selectedUser.id)
              : "Titkosított üzenet. Add meg a beszélgetéskulcsot a Beállításokban.";

            return {
              ...message,
              parsedContent: parseMessageContent(content),
              decryptedContent: content,
              decryptFailed: false
            };
          } catch {
            return {
              ...message,
              parsedContent: { type: "text", text: "Nem sikerült visszafejteni. Más a beszélgetéskulcs." },
              decryptedContent: "Nem sikerült visszafejteni. Más a beszélgetéskulcs.",
              decryptFailed: true
            };
          }
        })
      );

      if (!cancelled) setDecryptedMessages(items);
    }

    decryptVisibleMessages();

    return () => {
      cancelled = true;
    };
  }, [messages, chatSecret, selectedUser, user]);

  async function loadUsers() {
    try {
      const data = await api("/users");
      setUsers(data.users);
      setOnlineUserIds(data.onlineUserIds || []);
      setSelectedUser((current) => {
        if (!current) return current;
        return data.users.find((item) => item.id === current.id) || current;
      });
    } catch (error) {
      setChatError(error.message);
    }
  }

  async function loadConversation(otherUser) {
    setSelectedUser(otherUser);
    setChatError("");

    try {
      const data = await api(`/messages/${otherUser.id}`);
      setMessages(data.messages);
    } catch (error) {
      setChatError(error.message);
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthError("");

    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const data = await api(path, { method: "POST", body: JSON.stringify(authForm) });

      setSession(data.token, data.user);
      setUser(data.user);
      setProfileForm({
        displayName: data.user.display_name || "",
        avatarColor: data.user.avatar_color || AVATAR_COLORS[0]
      });
      setAuthForm({ username: "", password: "" });
    } catch (error) {
      setAuthError(error.message);
    }
  }

  function handleLogout() {
    disconnectSocket();
    clearSession();
    clearStoredChatSecret();
    setChatSecret("");
    setSecretDraft("");
    setUser(null);
    setSelectedUser(null);
    setMessages([]);
    setUsers([]);
    setOnlineUserIds([]);
  }

  async function saveProfile(event) {
    event.preventDefault();
    setChatError("");

    try {
      const data = await api("/me/profile", {
        method: "PATCH",
        body: JSON.stringify(profileForm)
      });

      updateStoredUser(data.user);
      setUser(data.user);
      await loadUsers();
    } catch (error) {
      setChatError(error.message);
    }
  }

  function saveChatSecret(event) {
    event.preventDefault();
    const nextSecret = secretDraft.trim();
    setStoredChatSecret(nextSecret);
    setChatSecret(nextSecret);
  }

  function createNewSecret() {
    const nextSecret = generateSecret();
    setSecretDraft(nextSecret);
    setStoredChatSecret(nextSecret);
    setChatSecret(nextSecret);
  }

  async function enablePush() {
    try {
      await enablePushNotifications();
      setPushStatus("Push értesítés bekapcsolva ezen az eszközön.");
    } catch (error) {
      setPushStatus(error.message);
    }
  }

  async function sendEncryptedContent(content) {
    if (!socket || !selectedUser) return;

    if (!chatSecret.trim()) {
      setChatError("Előbb add meg a beszélgetéskulcsot a Beállításokban.");
      setSettingsOpen(true);
      setSettingsTab("security");
      return;
    }

    const encryptedContent = await encryptMessage(content, chatSecret, user.id, selectedUser.id);

    socket.emit("message:send", { receiverId: selectedUser.id, content: encryptedContent }, (response) => {
      if (!response?.ok) {
        setChatError(response?.error || "Nem sikerült elküldeni.");
      }
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = messageText.trim();

    if (!text) return;

    await sendEncryptedContent(text);
    setMessageText("");
    setEmojiOpen(false);
  }

  async function sendImage(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setChatError("Csak képet lehet küldeni.");
      return;
    }

    const dataUrl = await imageFileToDataUrl(file);
    await sendEncryptedContent(JSON.stringify({ type: "image", dataUrl, name: file.name }));
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="brand">
            <span className="brand-mark">PC</span>
            <div>
              <h1>Privát Chat</h1>
              <p>Privát beszélgetések a saját körödnek.</p>
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Bejelentkezési mód">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">Belépés</button>
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">Regisztráció</button>
          </div>

          <form onSubmit={handleAuthSubmit}>
            <label>
              Felhasználónév
              <input autoComplete="username" value={authForm.username} onChange={(event) => setAuthForm({ ...authForm, username: event.target.value })} placeholder="pl. zsolt" />
            </label>

            <label>
              Jelszó
              <input autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} placeholder="legalább 8 karakter" />
            </label>

            {authError && <div className="error">{authError}</div>}

            <button className="primary-action" type="submit">{mode === "login" ? "Belépés" : "Fiók létrehozása"}</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className={selectedUser ? "app-shell chat-open" : "app-shell"}>
      <aside className="conversation-list">
        <header className="list-header">
          <button className="profile-pill" onClick={() => setSettingsOpen(true)} type="button">
            <span className="avatar small" style={{ background: user.avatar_color || AVATAR_COLORS[0] }}>{initials(displayName(user))}</span>
            <span>
              <span className="eyebrow">Privát Chat</span>
              <strong>{displayName(user)}</strong>
            </span>
          </button>
          <button className="icon-button" onClick={handleLogout} type="button" aria-label="Kilépés">×</button>
        </header>

        <div className="search-row">
          <input readOnly placeholder="Keresés" aria-label="Keresés" />
        </div>

        <button className="settings-entry" onClick={() => setSettingsOpen(true)} type="button">
          <span>Beállítások</span>
          <small>{chatSecret ? "Titkosítás bekapcsolva" : "Kulcs szükséges"}</small>
        </button>

        <div className="section-title">
          <h2>Beszélgetések</h2>
          <span>{users.length}</span>
        </div>

        <div className="users">
          {users.length === 0 && <p className="muted empty-list">Még nincs másik felhasználó.</p>}
          {users.map((item) => {
            const online = onlineUserIds.includes(item.id);
            return (
              <button key={item.id} className={selectedUser?.id === item.id ? "conversation selected" : "conversation"} onClick={() => loadConversation(item)} type="button">
                <span className="avatar" style={{ background: item.avatar_color || AVATAR_COLORS[0] }}>
                  {initials(displayName(item))}
                  <span className={online ? "presence online" : "presence"} />
                </span>
                <span className="conversation-copy">
                  <strong>{displayName(item)}</strong>
                  <small>{online ? "Online" : "Offline"} · titkosított chat</small>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="chat-screen">
        {!selectedUser ? (
          <div className="empty-chat">
            <div className="empty-mark">PC</div>
            <h2>Válassz beszélgetést</h2>
            <p>Telefonon a lista után teljes képernyőn nyílik meg a chat.</p>
          </div>
        ) : (
          <>
            <header className="chat-topbar">
              <button className="back-button" onClick={() => setSelectedUser(null)} type="button" aria-label="Vissza">‹</button>
              <span className="avatar small" style={{ background: selectedUser.avatar_color || AVATAR_COLORS[0] }}>
                {initials(displayName(selectedUser))}
                <span className={selectedUserIsOnline ? "presence online" : "presence"} />
              </span>
              <div className="chat-title">
                <h1>{displayName(selectedUser)}</h1>
                <span>{selectedUserIsOnline ? "Online most" : "Most offline"} · E2EE</span>
              </div>
              <button className="icon-button" type="button" aria-label="Hívás">☎</button>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} type="button" aria-label="Menü">⋮</button>
            </header>

            <div className="messages">
              <div className="day-divider">Titkosított beszélgetés</div>
              {decryptedMessages.map((message) => {
                const mine = message.sender_id === user.id;
                return (
                  <div key={message.id} className={mine ? "message mine" : "message"}>
                    <div className={message.decryptFailed ? "bubble failed" : "bubble"}>
                      {message.parsedContent?.type === "image" ? (
                        <img className="message-image" src={message.parsedContent.dataUrl} alt={message.parsedContent.name || "Küldött kép"} />
                      ) : (
                        <p>{message.parsedContent?.text || message.decryptedContent}</p>
                      )}
                      <time>{formatMessageTime(message.created_at)}</time>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {chatError && <div className="error chat-error">{chatError}</div>}

            <form className="composer" onSubmit={sendMessage}>
              {emojiOpen && (
                <div className="emoji-panel">
                  {EMOJIS.map((emoji) => (
                    <button key={emoji} type="button" onClick={() => setMessageText((value) => `${value}${emoji}`)}>{emoji}</button>
                  ))}
                </div>
              )}
              <div className="composer-input">
                <button type="button" onClick={() => setEmojiOpen((value) => !value)} aria-label="Emoji">☺</button>
                <input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder={chatSecret ? "Üzenet" : "Add meg a kulcsot a Beállításokban"} maxLength={2000} />
                <button type="button" onClick={() => fileInputRef.current?.click()} aria-label="Kép küldése">＋</button>
                <input ref={fileInputRef} className="hidden-file" type="file" accept="image/*" onChange={sendImage} />
              </div>
              <button className="send-button" type="submit" aria-label="Küldés">➤</button>
            </form>
          </>
        )}
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Beállítások">
          <section className="profile-modal">
            <div className="modal-header">
              <h2>Beállítások</h2>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Bezárás">×</button>
            </div>

            <div className="settings-tabs">
              <button className={settingsTab === "profile" ? "active" : ""} type="button" onClick={() => setSettingsTab("profile")}>Profil</button>
              <button className={settingsTab === "security" ? "active" : ""} type="button" onClick={() => setSettingsTab("security")}>Titkosítás</button>
            </div>

            {settingsTab === "profile" ? (
              <form className="settings-panel" onSubmit={saveProfile}>
                <div className="profile-preview">
                  <span className="avatar large" style={{ background: profileForm.avatarColor }}>{initials(profileForm.displayName || user.username)}</span>
                </div>
                <label>
                  Megjelenített név
                  <input value={profileForm.displayName} onChange={(event) => setProfileForm({ ...profileForm, displayName: event.target.value })} placeholder={user.username} maxLength={40} />
                </label>
                <div className="color-grid" aria-label="Avatar szín">
                  {AVATAR_COLORS.map((color) => (
                    <button key={color} className={profileForm.avatarColor === color ? "color-dot selected" : "color-dot"} style={{ background: color }} type="button" onClick={() => setProfileForm({ ...profileForm, avatarColor: color })} aria-label={`Avatar szín ${color}`} />
                  ))}
                </div>
                <button className="primary-action" type="submit">Profil mentése</button>
              </form>
            ) : (
              <form className="settings-panel" onSubmit={saveChatSecret}>
                <label>
                  Beszélgetéskulcs
                  <input type="password" value={secretDraft} onChange={(event) => setSecretDraft(event.target.value)} placeholder="közös titok a barátokkal" />
                </label>
                <p className="settings-note">Ugyanezt a kulcsot kell megadnia annak is, akivel beszélsz. A szerver csak titkosított szöveget tárol.</p>
                <div className="settings-actions">
                  <button type="button" onClick={createNewSecret}>Kulcs generálása</button>
                  <button className="primary-action" type="submit">{chatSecret ? "Kulcs frissítése" : "Kulcs mentése"}</button>
                </div>
                <div className="push-card">
                  <strong>Push értesítések</strong>
                  <p>{isPushSupported() ? "Kapj értesítést új üzenetről ezen az eszközön." : "Ez a böngésző nem támogatja a push értesítést."}</p>
                  <button type="button" onClick={enablePush} disabled={!isPushSupported()}>Push bekapcsolása</button>
                  {pushStatus && <small>{pushStatus}</small>}
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
