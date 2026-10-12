// The TD desk's Contacts section: the registration Sheet's Contacts tab, searched as you type, with
// each contact added, changed, or deleted through the registration script (contacts, contactSave,
// contactDelete). td.js loads the contacts at sign-in into contactBook and says so with a
// "td-contacts" event; call() and hidden() come from it too.

const contactsPanel = document.querySelector(".td-contacts-panel");
const contactsSearch = document.getElementById("td-contacts-search");
const contactsStatus = document.querySelector(".td-contacts-status");
const contactsTable = document.querySelector(".td-contacts");
const contactDialog = document.querySelector(".td-contact");
const contactForm = contactDialog.querySelector("form");
const contactStatus = contactDialog.querySelector(".td-contact-status");
const contactDelete = contactDialog.querySelector(".td-contact-delete");
const SHOWN = 100;
let editing = null;

function showContacts() {
  const all = contactBook.contacts;
  contactsPanel.querySelector("summary").textContent = `Contacts (${all.length})`;
  const words = contactsSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = all.filter((c) => {
    const text = Object.values(c).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  }).sort((a, b) => a.Name.localeCompare(b.Name));
  contactsStatus.textContent = words.length ? `${found.length} of ${all.length} match.`
    : found.length > SHOWN ? `Showing the first ${SHOWN}; search to find the rest.` : "";
  contactsTable.tBodies[0].replaceChildren(...found.slice(0, SHOWN).map((c) => {
    const row = document.createElement("tr");
    for (const heading of ["Name", "US Chess ID", "Email", "Phone", "Status", "Role"]) row.insertCell().textContent = c[heading] || "";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "td-action";
    edit.textContent = "Edit";
    edit.append(hidden(` ${c.Name}`));
    edit.addEventListener("click", () => openContact(c));
    row.insertCell().append(edit);
    return row;
  }));
  contactsTable.hidden = !found.length;
}

/** The dialog for a contact, or a new one: a field for each of the tab's headings. */
function openContact(contact) {
  editing = contact;
  contactDialog.querySelector("h2").textContent = contact ? contact.Name : "Add a contact";
  contactDelete.hidden = !contact;
  contactStatus.textContent = "";
  const fields = contactDialog.querySelector(".td-contact-fields");
  fields.replaceChildren(...contactBook.headings.flatMap((heading, i) => {
    const label = Object.assign(document.createElement("label"), { htmlFor: `td-contact-${i}`, textContent: heading });
    const input = document.createElement(heading === "Notes" ? "textarea" : "input");
    Object.assign(input, { id: `td-contact-${i}`, name: heading, value: contact?.[heading] || "", autocomplete: "off" });
    if (heading === "Notes") input.rows = 4;
    if (heading === "Name") input.required = true;
    if (heading === "US Chess ID") Object.assign(input, { inputMode: "numeric", pattern: "\\d{8}" });
    return [label, input];
  }));
  contactDialog.showModal();
}

/** Reloads the contacts after a change, so the list and the player search have what the Sheet has. */
async function reloadContacts(message) {
  const book = await call("contacts");
  if (book.contacts) contactBook = book;
  showContacts();
  contactsStatus.textContent = message;
}

contactForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  contactStatus.textContent = "Saving…";
  const fields = Object.fromEntries(new FormData(contactForm));
  const result = await call("contactSave", { id: editing?.id || "", fields: JSON.stringify(fields) });
  if (!result.ok) {
    contactStatus.textContent = result.error;
    return;
  }
  contactDialog.close();
  await reloadContacts(result.message);
});

contactDelete.addEventListener("click", async () => {
  if (!editing || !confirm(`Delete ${editing.Name} from the club's contacts? The Sheet's version history keeps a copy.`)) return;
  const result = await call("contactDelete", { id: editing.id });
  if (!result.ok) {
    contactStatus.textContent = result.error;
    return;
  }
  contactDialog.close();
  await reloadContacts(result.message);
});

contactForm.querySelector('[value="cancel"]').addEventListener("click", () => contactDialog.close());
document.querySelector(".td-contacts-add").addEventListener("click", () => openContact(null));
contactsSearch.addEventListener("input", showContacts);
document.addEventListener("td-contacts", showContacts);
