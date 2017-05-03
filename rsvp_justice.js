const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
const endpoint = 'https://api.meetup.com';

const fridayRsvpsFile = 'friday_rsvps.json';
var fridayRsvps;

function loadfridayRsvps() {
  fridayRsvps = JSON.parse(fs.readFileSync(fridayRsvpsFile, 'utf8'));
}

function savefridayRsvps() {
  fs.writeFileSync(fridayRsvpsFile, JSON.stringify(fridayRsvps, null, 2) + '\n');
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

function nextEventId() {
  return request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'upcoming', page: 10})
  .then(res => firstEventId(res.body));
}

function attendance(event_id) {
  return request.get(endpoint + '/' + urlname + '/events/' + event_id + '/attendance')
  .query({key})
  .then(res => res.body);
}

function errorExit(err) {
  console.log('error:', err);
  process.exit(1);
}

function prevEventAttendance() {
  return prevEventId()
  .then(event_id => {
    if (fridayRsvps.lastEventId == event_id) {
      errorExit('already done');
    } else {
      fridayRsvps.lastEventId = event_id;
      return attendance(event_id);
    }
  });
}

function rsvpsByEventId(event_id) {
  function trial(trialNext) {
    request.get(endpoint + '/2/rsvps')
    .query({key, event_id, rsvp: 'yes'})
    .end((err, res) => {
      if (err || !res.ok || !res.body.results) {
        trialNext('too many trials');
      } else {
        const rsvps = res.body.results;
        trialNext(null, {event_id, rsvps});
      }
    });
  }
  return new Promise((resolve, reject) => {
    async.retry(trial, (err, res) => err ? reject(err) : resolve(res));
  });
}

function setRsvpResponse(event_id, member_id, response, next) {
  console.log('setrsvp', event_id, member_id, response);
  request.post(endpoint + '/2/rsvp')
  .query({key, event_id, member_id, rsvp: response})
  .end(next);
}

function setBumps(bumps) {
  function setBump({event_id, member_id}, next) {
    setRsvpResponse(event_id, member_id, 'no', () =>
      setRsvpResponse(event_id, member_id, 'waitlist', next));
  }
  return new Promise((resolve, reject) => {
    async.eachSeries(bumps, setBump, (err, res) => err ? reject(err) : resolve(res));
  });
}

// break up into two functions
function adjust([attendedRsvps, events]) {
  const noshowRsvpIds = _.difference(
    _.map(fridayRsvps.members, 'member_id'),
    _.map(attendedRsvps, 'member.id')
  );
  return new Promise((resolve, reject) => {
    function adjustEvent(noshowRsvpIds, events, bumps = []) {
      if (noshowRsvpIds.length == 0 || events.length == 0) {
        console.log('bumps:\n', bumps);
        return resolve(bumps);
      }
      const event = events[0];
      const event_id = event.id;
      rsvpsByEventId(event_id)
      .then(eventRsvps => {
        const {event_id, rsvps} = eventRsvps;
        const eventRsvpIds = _.map(rsvps, 'member.member_id');
        const bumpableIds = _.intersection(noshowRsvpIds, eventRsvpIds);
        const newBumps = bumpableIds.map(member_id => {
          const event_name = event.name;
          const member_name = _.find(rsvps, ['member.member_id', member_id]).member.name;
          return {event_id, event_name, member_id, member_name};
        });
        const nextNoshowRsvpIds = _.difference(noshowRsvpIds, bumpableIds);
        const nextEvents = _.tail(events);
        const nextBumps = _.concat(bumps, newBumps);
        adjustEvent(nextNoshowRsvpIds, nextEvents, nextBumps);
      })
      .catch(err => 'rsvpsByEventId failed');
    }
    adjustEvent(noshowRsvpIds, events);
  });
}

function getSubcommand() {
  const subcommands = ['run', 'dryrun', 'save'];
  return process.argv[2];
  if (!_.includes(subcommands, subcommand)) {
    errorExit('invalid subcommand');
  }
}

function main() {
  const subcommand = getSubcommand();
  loadfridayRsvps();
  if (subcommand == 'save') {
    nextEventId()
    .then(rsvpsByEventId)
    .then(eventRsvps => {
      const {event_id, rsvps} = eventRsvps;
      fridayRsvps.members = _.map(rsvps, 'member');
      fridayRsvps.event_id = event_id;
    })
    .then(savefridayRsvps)
    .catch(errorExit);
  } else if (subcommand == 'run' || subcommand == 'dryrun') {
    const bumps = Promise.all([prevEventAttendance(), nextEventIds()])
    .then(adjust)
    .catch(errorExit);
    if (subcommand == 'run') {
      bumps.then(setBumps)
      .catch(errorExit);
    }
  }
}

main();
