const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
const endpoint = 'https://api.meetup.com';
const lastEventFile = 'last_event';
var last_event_id;

function loadLastEvent() {
  last_event_id = fs.readFileSync(lastEventFile, 'utf8').trim();
}

function saveLastEvent() {
  fs.writeFileSync(lastEventFile, last_event_id + '\n');
}

function mainEvents(events) {
  const mainEventFilter = event => (new Date(event.time)).getHours() == 13;
  return events.filter(mainEventFilter);
}

function firstEventId(events) {
  return mainEvents(events)[0].id;
}

function prevEventId() {
  return request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'past', desc: true, page: 10})
  .then(res => firstEventId(res.body));
}

function nextEventIds() {
  return request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'upcoming', page: 20})
  .then(res => mainEvents(res.body));
}

function attendance(event_id) {
  return request.get(endpoint + '/' + urlname + '/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .then(res => res.body);
}

function errorExit(err) {
  console.log('error:', err);
  process.exit(1);
}

function prevEventAttendance() {
  return prevEventId()
  .then(event_id => {
    if (last_event_id == event_id) {
      errorExit('already done');
    } else {
      last_event_id = event_id;
      return attendance(event_id);
    }
  });
}

function rsvpsByEventId(event_id, next) {
  function trial(trialNext) {
    request.get(endpoint + '/2/rsvps')
    .query({event_id, key, rsvp: 'yes'})
    .end((err, res) => {
      if (err || !res.ok || !res.body.results) {
        trialNext('too many trials');
      } else {
        trialNext(null, res.body.results);
      }
    });
  }
  async.retry(trial, next);
}

function setRsvpResponse(event_id, member_id, response, next) {
  console.log('setrsvp', event_id, member_id, response);
  request.post(endpoint + '/2/rsvp')
  .query({key, event_id, member_id, rsvp: response})
  .end(next);
}

function setBumps(bumps) {
  console.log('bumps:\n', bumps);
  if (process.argv[2] != 'run')
    return;
  function setBump({event_id, member_id}, next) {
    setRsvpResponse(event_id, member_id, 'no', () =>
      setRsvpResponse(event_id, member_id, 'waitlist', next));
  }
  return new Promise((resolve, reject) => {
    async.eachSeries(bumps, setBump, (err, res) => err ? reject(err) : resolve(res));
  });
}

function adjust([noshowRsvps, events]) {
  return new Promise((resolve, reject) => {
    function adjustEvent(noshowRsvps, events, bumps = []) {
      if (noshowRsvps.length == 0 || events.length == 0)
        return resolve(bumps);
      const event = events[0];
      const event_id = event.id;
      rsvpsByEventId(event_id, (err, eventRsvps) => {
        if (err)
          return reject('rsvpsByEventId failed');
        const noshowRsvpIds = _.map(noshowRsvps, 'member.id');
        const eventRsvpIds = _.map(eventRsvps, 'member.member_id');
        const bumpableIds = _.intersection(noshowRsvpIds, eventRsvpIds);
        const newBumps = bumpableIds.map(member_id => {
          const event_name = event.name;
          const member_name = _.find(noshowRsvps, ['member.id', member_id]).member.name;
          return {event_id, event_name, member_id, member_name};
        });
        const nextNoshowRsvps = _.reject(noshowRsvps, rsvp => _.includes(bumpableIds, rsvp.member.id));
        const nextEvents = _.tail(events);
        const nextBumps = _.concat(bumps, newBumps);
        adjustEvent(nextNoshowRsvps, nextEvents, nextBumps);
      });
    }
    adjustEvent(noshowRsvps, events);
  });
}

function main() {
  loadLastEvent();
  Promise.all([prevEventAttendance(), nextEventIds()])
  .then(adjust)
  .then(setBumps)
  .then(saveLastEvent)
  .catch(errorExit);
}

main();
