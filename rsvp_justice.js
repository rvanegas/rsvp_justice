const request = require('superagent');
const fs = require('fs');
const _ = require('lodash');

const demeritsFile = 'demerits.json';
const endpoint = 'https://api.meetup.com';
const key = '365716195410774d58f4f04c1c382a';

var demerits = {
  lastAdjudication: undefined,
  members: {},
};

function firstEvent(events) {
  const mainEvents = events.filter(event => {
    const date = new Date(event.time);
    return date.getHours() == 13;
  });
  return mainEvents[0].id;
}

function nextEventId(next) {
  request.get(endpoint + '/philosophy-184/events')
  .query({status: 'upcoming'})
  .end((err, res) => next(firstEvent(res.body)));
}

function prevEventId(next) {
  request.get(endpoint + '/philosophy-184/events')
  .query({status: 'past', desc: true})
  .end((err, res) => next(firstEvent(res.body)));
}

function rsvps(event_id, next) {
  request.get(endpoint + '/2/rsvps')
  .query({event_id, key})
  .end((err, res) => {
    console.log(res.body.results.map(r => {
      return _.pick(r, ['member', 'response', 'guests', 'rsvp_id']);
    }));
  });
}

function attendance(event_id, next) {
  request.get(endpoint + '/philosophy-184/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .end((err, res) => {
    next(res.body);
  });
}

function loadDemerits() {
  try {
    demerits = JSON.parse(fs.readFileSync(demeritsFile));
  } catch (e) {}
}

function saveDemerits() {
  fs.writeFileSync(demeritsFile, JSON.stringify(demerits));
}

function incrementPoints(next) {
  prevEventId(event_id => {
    attendance(event_id, noshows => {
      if (demerits.lastAdjudication != event_id) {
        demerits.lastAdjudication = event_id;
        noshows.forEach(noshow => {
          const {id, name} = noshow.member;
          const member = demerits.members[id];
          const points = (member && member.points + 1) || 1;
          demerits.members[id] = {name, points};
        });
        next();
      }
    });
  });
}

loadDemerits();
incrementPoints(saveDemerits);
nextEventId(event_id => rsvps(event_id));
