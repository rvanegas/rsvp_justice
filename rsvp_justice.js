const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
const endpoint = 'https://api.meetup.com';

function promisify(fn) {
  return function() {
    return new Promise((resolve, reject) => {
      const callback = (err, res) => err ? reject(err) : resolve(res);
      const newArgs = _.concat([...arguments], callback);
      fn.apply(this, newArgs);
    });
  };
}

const promiseAsyncRetry = promisify(async.retry);
const promiseAsyncEachSeries = promisify(async.eachSeries);

const savedRsvpsFile = 'saved_rsvps.json';
var savedRsvps;

function readSavedRsvps() {
  savedRsvps = JSON.parse(fs.readFileSync(savedRsvpsFile, 'utf8'));
}

function writeSavedRsvps() {
  fs.writeFileSync(savedRsvpsFile, JSON.stringify(savedRsvps, null, 2) + '\n');
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
    if (savedRsvps.lastEventId == event_id) {
      errorExit('already done');
    } else {
      savedRsvps.lastEventId = event_id;
      return attendance(event_id);
    }
  });
}

function rsvpsByEventId(event_id) {
  function trial(next) {
    request.get(endpoint + '/2/rsvps')
    .query({key, event_id, rsvp: 'yes'})
    .end((err, res) => {
      if (err || !res.ok || !res.body.results) {
        next('too many trials');
      } else {
        const rsvps = res.body.results;
        next(null, {event_id, rsvps});
      }
    });
  }
  return promiseAsyncRetry(trial);
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
  return promiseAsyncEachSeries(bumps, setBump);
}

function adjustEventStep(noshowRsvpIds, events, bumps, next) {
  if (noshowRsvpIds.length == 0 || events.length == 0) {
    console.log('bumps:\n', bumps);
    return next(null, bumps);
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
    adjustEventStep(nextNoshowRsvpIds, nextEvents, nextBumps, next);
  })
  .catch(err => 'rsvpsByEventId failed');
}

function adjustEvent(noshowRsvpIds, events, next) {
  adjustEventStep(noshowRsvpIds, events, [], next);
}

const promiseAdjustEvent = promisify(adjustEvent);

function adjust([attendedRsvps, events]) {
  const noshowRsvpIds = _.difference(
    _.map(savedRsvps.members, 'member_id'),
    _.map(attendedRsvps, 'member.id')
  );
  return promiseAdjustEvent(noshowRsvpIds, events);
}

function setSavedRsvps(eventRsvps) {
  const {event_id, rsvps} = eventRsvps;
  savedRsvps.members = _.map(rsvps, 'member');
  savedRsvps.event_id = event_id;
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
  readSavedRsvps();
  if (subcommand == 'save') {
    nextEventId()
    .then(rsvpsByEventId)
    .then(setSavedRsvps)
    .then(writeSavedRsvps)
    .catch(errorExit);
  } else if (subcommand == 'run' || subcommand == 'dryrun') {
    const bumps = Promise.all([
      prevEventAttendance(),
      nextEventIds()
    ])
    .then(adjust)
    .catch(errorExit);
    if (subcommand == 'run') {
      bumps.then(setBumps)
      .catch(errorExit);
    }
  }
}

main();
