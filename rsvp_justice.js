const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
const endpoint = 'https://api.meetup.com';
const demeritsFile = 'demerits.json';

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
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'upcoming', page: 10})
  .end((err, res) => next(err, res && firstEvent(res.body)));
}

function prevEventId(next) {
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'past', desc: true, page: 10})
  .end((err, res) => next(err, res && firstEvent(res.body)));
}

function eventRsvps(event_id, next) {
  function trial(trialNext) {
    request.get(endpoint + '/2/rsvps')
    .query({event_id, key})
    .end((err, res) => {
      if (err || !res.ok || !res.body.results) {
        console.log('retrying...');
        trialNext('too many trials');
      } else {
        const fields = ['mtime', 'member', 'response', 'guests'];
        const rsvps = res.body.results.map(r => _.pick(r, fields));
        trialNext(null, rsvps);
      }
    });
  }
  async.retry(trial, next);
}

function attendance(event_id, next) {
  request.get(endpoint + '/' + urlname + '/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .end((err, res) => next(err, res && res.body));
}

function loadDemerits() {
  try {
    demerits = JSON.parse(fs.readFileSync(demeritsFile));
  } catch (e) {}
}

function saveDemerits() {
  fs.writeFileSync(demeritsFile, JSON.stringify(demerits, null, 2));
}

function incrementPoints(next) {
  prevEventId((err, event_id) => {
    err ? next(err) :
    attendance(event_id, (err, noshows) => {
      if (err) {
        next(err);
      } else if (demerits.lastAdjudication == event_id) {
        next('already done');
      } else {
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

function decrementPoints(member_id, next) {
  demerits.members[member_id].points -= 1;
  next();
}

function injustice(rsvps, next) {
  rsvps.map(rsvp => {
    const demeritMember = demerits.members[rsvp.member.member_id];
    const points = demeritMember ? demeritMember.points : 0;
    _.assign(rsvp, {points});
  });
  const order = rsvp => [rsvp.points, rsvp.mtime];
  const highestYes = _.maxBy(_.filter(rsvps, {response: 'yes'}), order);
  const lowestWaitlist = _.minBy(_.filter(rsvps, {response: 'waitlist'}), order);
  highestYes.points > lowestWaitlist.points ?
  next(null, highestYes, lowestWaitlist) :
  next(true);
}

function setRsvpResponse(event_id, member_id, rsvp, next) {
  request.post(endpoint + '/2/rsvps')
  .query({event_id, member_id, rsvp})
  .end(next);
}

function swapPairMock(event_id, highestYes, lowestWaitlist, next) {
  console.log(highestYes);
  console.log(lowestWaitlist);
  next(true);
}

function swapPair(event_id, highestYes, lowestWaitlist, next) {
  setRsvpResponse(event_id, highestYes.member.member_id, 'waitlist', () => {
    setRsvpResponse(event_id, lowestWaitlist.member.member_id, 'yes', () => {
      decrementPoints(highestYes.member.member_id, next);
    });
  });
}

function adjudicate(next) {
  loadDemerits();
  incrementPoints((err) => {
    err ? next(err) :
    nextEventId((err, event_id) => {
      function adjust(adjustNext) {
        eventRsvps(event_id, (err, rsvps) => {
          err ? next(err) :
          injustice(rsvps, (done, highestYes, lowestWaitlist) => {
            done ? adjustNext(true) :
            swapPairMock(event_id, highestYes, lowestWaitlist, adjustNext);
          });
        });
      }
      err ? next(err) :
      async.forever(adjust, saveDemerits);
    });
  });
}

adjudicate((err) => {
  if (err) {
    console.log('error:', err);
    process.exit(1);
  }
});
