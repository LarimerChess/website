// English desktop Facebook controls captured from the club's signed-in forms.
const fields = {
  title: 'label=Event name', startDate: 'label=Start date', startTime: 'label=Start time',
  endDate: 'label=End date', endTime: 'label=End time', location: 'label=Add location',
  body: 'label=What are the details?',
};
const edit = { action: 'click', selector: 'a[href^="/events/edit/"]' };
const identify = [{ action: 'click', selector: 'text=See more', ifPresent: true }];
const groupSelector = 'text=Larimer County Chess Club';
const identitySelector = 'contains=Calendar reference: {marker}';
const form = {
  fields, verify: fields, timeZoneSelector: 'label=Time zone', timeZoneText: '{timeZone}',
  formGroupSelector: 'label=Who can see it?', formGroupText: 'Larimer County Chess Club',
  afterFill: { location: [{ action: 'click', selector: 'option=Just use "{location}"' }] },
  groupSelector, read: [edit],
};
export const facebookUI = {
  verified: false,
  authenticatedSelector: '[role="button"][aria-label="Account, your profile"]',
  create: { ...form, open: [
    { action: 'click', selector: 'text=Create event' },
    { action: 'click', selector: '[aria-label="Add end date and time"]' },
    { action: 'click', selector: 'label=Is it in person or virtual?' },
    { action: 'click', selector: 'option=In person' },
  ], commit: [{ action: 'click', selector: '[role="dialog"] [aria-label="Create event"]' }] },
  update: { ...form, identify, identitySelector, open: [edit], commit: [{ action: 'click', selector: 'text=Save' }] },
  cancel: {
    groupSelector, identify, identitySelector,
    open: [{ action: 'click', selector: '[role="button"][aria-label="More"]' }, { action: 'click', selector: 'text=Cancel Event' }],
    cancelChoiceSelector: "label=Cancel Event If you cancel your event, guests will be notified. You'll be able to access the event page but won't be able to edit the event.",
    commit: [{ action: 'click', selector: 'text=Confirm' }], read: [],
    cancelledSelector: 'cancelled-status', cancelledText: 'cancelled-status',
  },
};
