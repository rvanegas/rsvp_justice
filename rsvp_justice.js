const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
const endpoint = 'https://api.meetup.com';
const demeritsFile = 'demerits.json';

var demerits;

function loadDemerits() {
  try {
    demerits = JSON.parse(fs.readFileSync(demeritsFile));
  } catch (e) {
    demerits = {
      lastAdjudication: undefined,
      members: {},
    };
  }
}

function saveDemerits() {
  fs.writeFileSync(demeritsFile, JSON.stringify(demerits, null, 2));
}

function firstEventId(events) {
  const mainEvents = events.filter(event => {
    const date = new Date(event.time);
    return date.getHours() == 13;
  });
  return mainEvents[0].id;
}

function nextEventId(next) {
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'upcoming', page: 10})
  .end((err, res) => next(err, res && firstEventId(res.body)));
}

function prevEventId(next) {
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'past', desc: true, page: 10})
  .end((err, res) => next(err, res && firstEventId(res.body)));
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
        const rsvps = res.body.results.map(rsvp => _.pick(rsvp, fields));
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

function decrementPoints(member) {
  demerits.members[member.member_id].points -= 1;
}

function injustice(rsvps, next) {
  rsvps.map(rsvp => {
    const demeritMember = demerits.members[rsvp.member.member_id];
    const points = demeritMember ? demeritMember.points : 0;
    _.assign(rsvp, {points});
  });
  const order = rsvp => [rsvp.points, rsvp.mtime];
  const lowestWaitlist = _.minBy(_.filter(rsvps, {response: 'waitlist'}), order);
  const swapFilter = rsvp => rsvp.response == 'yes' && rsvp.points > lowestWaitlist.points;
  const swappables = _.reverse(_.sortBy(_.filter(rsvps, swapFilter), order));
  const waitlistCount = lowestWaitlist.guests + 1;

  // functionalize
  var yesCount = 0;
  var just = true;
  for (var swapIdx in swappables) {
    yesCount += swappables[swapIdx].guests + 1;
    if (yesCount >= waitlistCount) {
      just = false;
      var unjustYess = swappables.slice(0, swapIdx + 1);
      break;
    }
  }
  just ? next(true) : next(null, lowestWaitlist, unjustYess);
}

function mockSetRsvpResponse(event_id, move, next) {
  const {rsvp, response} = move;
  console.log('setrsvp', event_id, rsvp.member.member_id, rsvp.member.name, response);
  next();
}

function setRsvpResponse(event_id, move, next) {
  const {rsvp, response} = move;
  const member_id = rsvp.member.member_id;
  const guests = rsvp.guests;
  request.post(endpoint + '/2/rsvps')
  .query({event_id, member_id, response, guests})
  .end(next);
}

function swapRsvps(event_id, lowestWaitlist, unjustYess, next) {
  function setResponse(move, nextSeries) {
    mockSetRsvpResponse(event_id, move, nextSeries);
  }
  const moves = _.concat(
    {rsvp: lowestWaitlist, response: 'yes'},
    unjustYess.map(rsvp => ({rsvp, response: 'waitlist'}))
  );
  async.eachSeries(moves, setResponse, err => {
    if (!err) unjustYess.map(rsvp => decrementPoints(rsvp.member));
    next(err);
  });
}

function adjudicate(next) {
  loadDemerits();
  incrementPoints(err => {
    err ? next(err) :
    nextEventId((err, event_id) => {
      function adjust(adjustNext) {
        eventRsvps(event_id, (err, rsvps) => {
          err ? next(err) :
          injustice(rsvps, (done, lowestWaitlist, unjustYess) => {
            done ? adjustNext(true) :
            swapRsvps(event_id, lowestWaitlist, unjustYess, adjustNext);
          });
        });
      }
      err ? next(err) :
      async.forever(adjust, saveDemerits);
    });
  });
}

adjudicate(err => {
  if (err) {
    console.log('error:', err);
    process.exit(1);
  }
});
